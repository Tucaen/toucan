import { createHash } from 'node:crypto'
import { mkdirSync, watch, type FSWatcher } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import {
  DEFAULT_ORCHESTRATION_CONFIG,
  effectiveOrchestrationConfig,
  missingProviderTiers,
  parseOrchestrationConfig,
  type OrchestrationConfig,
  type OrchestrationConfigFile
} from '../shared/orchestration-routing'
import type { AgentProvider } from '../shared/agent-provider'
import type { OrchestrationConfigFileState, OrchestrationConfigScope } from '../shared/orchestration-settings'
import { pathIdentity } from '../shared/paths'
import { sessionOutcomeSlug } from '../shared/session-outcome'
import { errorMessage } from '../shared/text'
import { writeNewFileDurably, writeThroughTemporary } from './durable-file'

/**
 * The orchestration configuration on disk (#36; plan in `docs/plans/orchestrator-mode.md`): the tier
 * mapping and the implementation skill, in one user file at `<userData>\orchestration-config.json`
 * and an optional override per project at `<userData>\orchestration-config\<folder>--<hash>.json`.
 *
 * The files are the source of truth - a human or an agent edits them - so they are read afresh at
 * every load rather than cached, and a file that does not parse is refused with its path instead of
 * being answered with the defaults: routing on a mapping the user did not write is worse than not
 * routing. The user file is written out with the defaults the first time it is missing, so there is
 * always a file to find and edit.
 */
export interface OrchestrationConfigLoad {
  /** Undefined when a file could not be used; `error` says which and why. */
  config?: OrchestrationConfig
  error?: string
  userPath: string
  /** The project's override, when one exists. */
  projectPath?: string
}

export interface OrchestrationConfigStore {
  load(provider: AgentProvider, projectPath: string): Promise<OrchestrationConfigLoad>
  /** Where a project's override lives, whether or not it exists yet. */
  projectConfigPath(projectPath: string): string
  /** One file on its own, for the settings panel (#39); the project scope needs `projectPath`. */
  inspect(scope: OrchestrationConfigScope, projectPath?: string): Promise<OrchestrationConfigFileState>
  /**
   * Replaces one file whole with a validated configuration. A file that does not parse is refused
   * rather than replaced: it is most likely a hand edit in progress.
   */
  write(scope: OrchestrationConfigScope, projectPath: string | undefined, file: OrchestrationConfigFile): Promise<void>
  /** Calls `listener` after the user file or any override changes on disk, whoever changed it. */
  watch(listener: () => void): () => void
}

const USER_FILE = 'orchestration-config.json'
const PROJECT_DIRECTORY = 'orchestration-config'
const PROJECT_SLUG_LIMIT = 32
/** One save lands as several raw events (temp file, rename); they are reported as one change. */
const WATCH_COALESCE_MS = 50
/** How soon a watch that failed is tried again. */
const WATCH_RETRY_MS = 2000

export function createOrchestrationConfigStore(options: { userDataPath: string }): OrchestrationConfigStore {
  const userPath = join(options.userDataPath, USER_FILE)

  const projectConfigPath = (projectPath: string): string => {
    const identity = pathIdentity(projectPath)
    const hash = createHash('sha256').update(identity).digest('hex').slice(0, 8)
    const folder = sessionOutcomeSlug(basename(identity.replace(/[\\/]+$/, '')), PROJECT_SLUG_LIMIT) || 'project'
    return join(options.userDataPath, PROJECT_DIRECTORY, `${folder}--${hash}.json`)
  }

  /** The file's configuration, `null` when there is none, or the reason it cannot be used. */
  const read = async (path: string): Promise<OrchestrationConfigFile | null | { error: string }> => {
    let text: string
    try {
      text = await readFile(path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      return { error: `the orchestration configuration ${path} could not be read: ${errorMessage(error)}` }
    }
    let value: unknown
    try {
      value = JSON.parse(text)
    } catch (error) {
      return { error: `the orchestration configuration ${path} is not valid JSON: ${errorMessage(error)}` }
    }
    const parsed = parseOrchestrationConfig(value)
    return parsed.error !== undefined
      ? { error: `the orchestration configuration ${path} is invalid: ${parsed.error}` }
      : parsed.config
  }

  const writeDefaults = async (): Promise<void> => {
    try {
      await mkdir(dirname(userPath), { recursive: true })
      // Exclusive: a file that appeared meanwhile - an agent writing one - is never replaced.
      await writeNewFileDurably(userPath, `${JSON.stringify({ claude: DEFAULT_ORCHESTRATION_CONFIG }, null, 2)}\n`)
    } catch {
      // The defaults still apply; the file is only a convenience for the next edit.
    }
  }

  const pathOf = (scope: OrchestrationConfigScope, projectPath: string | undefined): string => {
    if (scope === 'user') return userPath
    if (!projectPath) throw new Error('a project override needs the project path')
    return projectConfigPath(projectPath)
  }

  return {
    projectConfigPath,
    async inspect(scope, projectPath) {
      const path = pathOf(scope, projectPath)
      const found = await read(path)
      if (found === null) return { path, exists: false }
      return 'error' in found ? { path, exists: true, error: found.error } : { path, exists: true, file: found }
    },
    async write(scope, projectPath, file) {
      const path = pathOf(scope, projectPath)
      const parsed = parseOrchestrationConfig(file)
      if (parsed.error !== undefined) throw new Error(`the orchestration configuration is invalid: ${parsed.error}`)
      const current = await read(path)
      if (current && 'error' in current) throw new Error(current.error)
      // Hidden temp name: the watcher and a reader of the folder never see a half-written file.
      await writeThroughTemporary(path, `${JSON.stringify(parsed.config, null, 2)}\n`)
    },
    watch(listener) {
      const projectDirectory = join(options.userDataPath, PROJECT_DIRECTORY)
      let timer: ReturnType<typeof setTimeout> | undefined
      const changed = (): void => {
        if (timer) clearTimeout(timer)
        timer = setTimeout(() => {
          timer = undefined
          listener()
        }, WATCH_COALESCE_MS)
      }
      const watchers = new Set<FSWatcher>()
      const retries = new Set<ReturnType<typeof setTimeout>>()
      let stopped = false
      const follow = (directory: string, relevant: (name: string) => boolean): void => {
        if (stopped) return
        // A folder removed or made unreadable is watched again once it can be, not given up on.
        const retry = (): void => {
          const retryTimer = setTimeout(() => {
            retries.delete(retryTimer)
            follow(directory, relevant)
          }, WATCH_RETRY_MS)
          retries.add(retryTimer)
        }
        try {
          mkdirSync(directory, { recursive: true })
          const watcher = watch(directory, (_event, name) => {
            if (name === null || relevant(name.toString())) changed()
          })
          watcher.on('error', () => {
            watcher.close()
            watchers.delete(watcher)
            retry()
          })
          watchers.add(watcher)
        } catch {
          retry()
        }
      }
      follow(options.userDataPath, (name) => name === USER_FILE)
      follow(projectDirectory, (name) => name.endsWith('.json') && !name.startsWith('.'))
      return () => {
        stopped = true
        if (timer) clearTimeout(timer)
        for (const retryTimer of retries) clearTimeout(retryTimer)
        for (const watcher of watchers) watcher.close()
      }
    },
    async load(provider, projectPath) {
      const overridePath = projectConfigPath(projectPath)
      const [user, project] = await Promise.all([read(userPath), read(overridePath)])
      const base = { userPath, ...(project ? { projectPath: overridePath } : {}) }
      if (user && 'error' in user) return { ...base, error: user.error }
      if (project && 'error' in project) return { ...base, error: project.error }
      if (user === null) await writeDefaults()
      const userFile = user ?? undefined
      const projectFile = project ?? undefined
      const config = effectiveOrchestrationConfig(provider, userFile, projectFile)
      if (!config) {
        const missing = missingProviderTiers(provider, userFile, projectFile)
        return {
          ...base,
          error:
            `the ${provider} orchestration tier mapping is missing ${missing.join(', ')}; ` +
            `configure the ${provider} provider in Orchestration settings (${userPath})`
        }
      }
      return { ...base, config }
    }
  }
}

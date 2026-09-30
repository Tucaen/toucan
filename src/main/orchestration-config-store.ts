import { createHash } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import {
  DEFAULT_ORCHESTRATION_CONFIG,
  effectiveOrchestrationConfig,
  parseOrchestrationConfig,
  type OrchestrationConfig,
  type OrchestrationConfigFile
} from '../shared/orchestration-routing'
import { pathIdentity } from '../shared/paths'
import { sessionOutcomeSlug } from '../shared/session-outcome'
import { errorMessage } from '../shared/text'
import { writeNewFileDurably } from './durable-file'

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
  load(projectPath: string): Promise<OrchestrationConfigLoad>
  /** Where a project's override lives, whether or not it exists yet. */
  projectConfigPath(projectPath: string): string
}

const USER_FILE = 'orchestration-config.json'
const PROJECT_DIRECTORY = 'orchestration-config'
const PROJECT_SLUG_LIMIT = 32

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
      await writeNewFileDurably(userPath, `${JSON.stringify(DEFAULT_ORCHESTRATION_CONFIG, null, 2)}\n`)
    } catch {
      // The defaults still apply; the file is only a convenience for the next edit.
    }
  }

  return {
    projectConfigPath,
    async load(projectPath) {
      const overridePath = projectConfigPath(projectPath)
      const [user, project] = await Promise.all([read(userPath), read(overridePath)])
      const base = { userPath, ...(project ? { projectPath: overridePath } : {}) }
      if (user && 'error' in user) return { ...base, error: user.error }
      if (project && 'error' in project) return { ...base, error: project.error }
      if (user === null) await writeDefaults()
      return { ...base, config: effectiveOrchestrationConfig(user ?? undefined, project ?? undefined) }
    }
  }
}

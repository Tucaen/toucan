import { stat } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import type { AgentProvider } from '../shared/agent-provider'
import { pathIdentity } from '../shared/paths'
import {
  emptyPluginRegistry,
  parsePluginRegistry,
  reachesCodex,
  type CodexMcpServer,
  type PluginAddResult,
  type PluginChangeResult,
  type PluginContributionsResult,
  type PluginManifest,
  type PluginRegistryState,
  type PluginSummary
} from '../shared/plugins'
import { errorMessage } from '../shared/text'
import { createCodexPluginSkills, type CodexPluginSkills } from './codex-plugin-skills'
import { createDurableJsonStore } from './durable-json-store'
import { readPluginContributions, readPluginFolder, readPluginMcpServers } from './plugin-folder'

/** One enabled plugin as a session launch carries it. */
export interface SessionPlugin {
  id: string
  /** The plugin's folder, absolute: what Claude loads, and what the session instruction names. */
  root: string
  /**
   * What a Codex session needs translated, since Codex has no plugins of its own; absent for Claude,
   * which loads the folder - skills, MCP servers and hooks - itself. Hooks never reach Codex.
   */
  codex?: {
    /**
     * A Toucan-owned directory to grant as an additional directory, whose `.agents/skills` links
     * to the plugin's `skills/` (`codex-plugin-skills.ts`); absent when the plugin has no skills or
     * the link failed.
     */
    skillsRoot?: string
    /** The plugin's MCP servers Codex can connect to, its root filled in. */
    mcpServers: CodexMcpServer[]
  }
}

/** What one session launch carries: the usable plugins, and a notice for every part it skipped. */
export interface SessionPlugins {
  plugins: SessionPlugin[]
  notices: string[]
}

/**
 * The plugin registry (#55): `<userData>/plugins.json` behind a durable store. The file only ever
 * says where a plugin lives and which projects enabled it; the folder itself is read again
 * (`plugin-folder.ts`) every time it matters, so an edit applies to the next session and a folder
 * that went away is noticed where it is used.
 */
export interface PluginRegistry {
  /** Every registered plugin as its folder reads now, with whether `projectPath` enabled it. */
  list(projectPath?: string): Promise<PluginSummary[]>
  /** Registers the folder under the id its manifest names; an id registered from another folder is refused. */
  add(path: string): Promise<PluginAddResult>
  /** Unregisters the id and drops it from every project; an unknown id is already removed. */
  remove(id: string): Promise<PluginChangeResult>
  enable(projectPath: string, id: string): Promise<PluginChangeResult>
  disable(projectPath: string, id: string): Promise<PluginChangeResult>
  /** What the plugin's folder contributes right now, for the trust step before enabling it. */
  contributions(id: string): Promise<PluginContributionsResult>
  /**
   * The plugins a session in `projectPath` (the main checkout - the caller resolves a worktree to
   * it) carries. A plugin, or a part of one, that cannot be used is skipped with a notice; this
   * rejects only when the registry file itself cannot be read.
   */
  forSession(request: { provider: AgentProvider; projectPath: string }): Promise<SessionPlugins>
}

export interface PluginRegistryOptions {
  userDataPath: string
  log?: (message: string) => void
  /** Where a Codex session finds a plugin's skills; the links under `<userData>` unless a test says otherwise. */
  codexSkills?: CodexPluginSkills
}

/** `record[key]` for an own key only: a plugin named `constructor` must not find `Object.prototype`'s. */
function own<T>(record: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined
}

/** The key a project's enablement is stored under: the same path in any spelling. */
function projectKey(state: PluginRegistryState, projectPath: string): string | undefined {
  const identity = pathIdentity(projectPath)
  return Object.keys(state.projects).find((key) => pathIdentity(key) === identity)
}

function enabledIds(state: PluginRegistryState, projectPath: string): string[] {
  const key = projectKey(state, projectPath)
  return key === undefined ? [] : (own(state.projects, key) ?? [])
}

/** `projects` with one project's list replaced; an empty list drops the project. */
function withProject(state: PluginRegistryState, key: string, ids: string[]): PluginRegistryState {
  const { [key]: _previous, ...others } = state.projects
  return { ...state, projects: ids.length > 0 ? { ...others, [key]: ids } : others }
}

/** A registered plugin as read now. A manifest that renamed the plugin no longer validates as this id. */
type RegisteredPlugin =
  { ok: true; root: string; manifest: PluginManifest; raw: Record<string, unknown> } | { ok: false; problem: string }

async function readRegistered(state: PluginRegistryState, id: string): Promise<RegisteredPlugin> {
  const entry = own(state.plugins, id)
  if (!entry) return { ok: false, problem: `No plugin named "${id}" is registered.` }
  const folder = await readPluginFolder(entry.path)
  if (!folder.ok) return folder
  if (folder.manifest.name !== id) return { ok: false, problem: `Its manifest now names it "${folder.manifest.name}".` }
  return { ...folder, root: entry.path }
}

export function createPluginRegistry(options: PluginRegistryOptions): PluginRegistry {
  const store = createDurableJsonStore<PluginRegistryState>({
    path: join(options.userDataPath, 'plugins.json'),
    parse: parsePluginRegistry,
    fallback: emptyPluginRegistry,
    ...(options.log ? { log: options.log } : {})
  })
  const codexSkills = options.codexSkills ?? createCodexPluginSkills(options.userDataPath)

  /** The Codex half of one plugin; every problem is a notice and costs only the part it is about. */
  const codexTranslation = async (
    plugin: { id: string; root: string; raw: Record<string, unknown> },
    notices: string[]
  ): Promise<NonNullable<SessionPlugin['codex']>> => {
    const notice = (text: string): void => void notices.push(`Plugin "${plugin.id}": ${text}`)
    const mcp = await readPluginMcpServers(plugin.root, plugin.raw)
    for (const problem of mcp.problems) notice(problem)
    for (const server of mcp.servers)
      if (!reachesCodex(server)) notice(`MCP server "${server.name}" uses SSE, which Codex cannot connect to.`)
    const mcpServers = mcp.servers.filter(reachesCodex)
    const skills = join(plugin.root, 'skills')
    const hasSkills = await stat(skills).then(
      (entry) => entry.isDirectory(),
      () => false
    )
    if (!hasSkills) return { mcpServers }
    try {
      return { skillsRoot: await codexSkills.rootFor(plugin.id, skills), mcpServers }
    } catch (error) {
      notice(`its skills could not be offered to Codex: ${errorMessage(error)}`)
      return { mcpServers }
    }
  }

  return {
    async list(projectPath) {
      const state = await store.load()
      const enabled = projectPath === undefined ? undefined : enabledIds(state, projectPath)
      return Promise.all(
        Object.entries(state.plugins).map(async ([id, entry]): Promise<PluginSummary> => {
          const plugin = await readRegistered(state, id)
          return {
            id,
            root: entry.path,
            ...(plugin.ok ? { manifest: plugin.manifest } : { problem: plugin.problem }),
            ...(enabled ? { enabled: enabled.includes(id) } : {})
          }
        })
      )
    },
    async add(path) {
      if (!isAbsolute(path)) return { ok: false, error: 'A plugin is added by the absolute path of its folder.' }
      const root = resolve(path)
      const folder = await readPluginFolder(root)
      if (!folder.ok) return { ok: false, error: folder.problem }
      const { manifest } = folder
      return store.update<PluginAddResult>((state) => {
        const existing = own(state.plugins, manifest.name)
        if (existing && pathIdentity(existing.path) !== pathIdentity(root))
          return {
            value: state,
            result: {
              ok: false,
              error: `A plugin named "${manifest.name}" is already registered from ${existing.path}. Remove it first to use this folder instead.`
            }
          }
        return {
          value: existing ? state : { ...state, plugins: { ...state.plugins, [manifest.name]: { path: root } } },
          result: { ok: true, plugin: { id: manifest.name, root: existing?.path ?? root, manifest } }
        }
      })
    },
    remove(id) {
      return store.update<PluginChangeResult>((state) => {
        if (!own(state.plugins, id)) return { value: state, result: { ok: true } }
        const { [id]: _removed, ...plugins } = state.plugins
        const projects = Object.fromEntries(
          Object.entries(state.projects)
            .map(([key, ids]) => [key, ids.filter((enabled) => enabled !== id)] as const)
            .filter(([, ids]) => ids.length > 0)
        )
        return { value: { plugins, projects }, result: { ok: true } }
      })
    },
    async enable(projectPath, id) {
      if (!isAbsolute(projectPath))
        return { ok: false, error: 'A plugin is enabled for a project by the absolute path of its checkout.' }
      return store.update<PluginChangeResult>((state) => {
        if (!own(state.plugins, id))
          return { value: state, result: { ok: false, error: `No plugin named "${id}" is registered.` } }
        const ids = enabledIds(state, projectPath)
        if (ids.includes(id)) return { value: state, result: { ok: true } }
        return {
          value: withProject(state, projectKey(state, projectPath) ?? projectPath, [...ids, id]),
          result: { ok: true }
        }
      })
    },
    disable(projectPath, id) {
      return store.update<PluginChangeResult>((state) => {
        const key = projectKey(state, projectPath)
        const ids = enabledIds(state, projectPath)
        if (key === undefined || !ids.includes(id)) return { value: state, result: { ok: true } }
        return {
          value: withProject(
            state,
            key,
            ids.filter((enabled) => enabled !== id)
          ),
          result: { ok: true }
        }
      })
    },
    async contributions(id) {
      const plugin = await readRegistered(await store.load(), id)
      if (!plugin.ok) return { ok: false, error: plugin.problem }
      return { ok: true, contributions: await readPluginContributions(id, plugin.root, plugin) }
    },
    async forSession({ provider, projectPath }) {
      const state = await store.load()
      const plugins: SessionPlugin[] = []
      const notices: string[] = []
      for (const id of enabledIds(state, projectPath)) {
        const plugin = await readRegistered(state, id)
        if (!plugin.ok) {
          notices.push(`Plugin "${id}" was skipped for this session. ${plugin.problem}`)
          continue
        }
        const { root } = plugin
        plugins.push(
          provider === 'codex'
            ? { id, root, codex: await codexTranslation({ id, root, raw: plugin.raw }, notices) }
            : { id, root }
        )
      }
      return { plugins, notices }
    }
  }
}

import { lstat, mkdir, readdir, readFile, realpath, stat, symlink, unlink } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import type { AgentProvider } from '../shared/agent-provider'
import { lenientFrontmatter } from '../shared/frontmatter'
import { pathIdentity } from '../shared/paths'
import {
  PLUGIN_MANIFEST_SEGMENTS,
  emptyPluginRegistry,
  parsePluginRegistry,
  pluginHooks,
  pluginMcpServers,
  validatePluginManifest,
  type PluginAddResult,
  type PluginChangeResult,
  type PluginContributions,
  type PluginContributionsResult,
  type PluginManifest,
  type PluginMcpServer,
  type PluginRegistryState,
  type PluginSkill,
  type PluginSummary
} from '../shared/plugins'
import { PROJECT_SKILLS_DIRECTORY, SKILL_DEFINITION_FILE } from '../shared/project-skills'
import { isRecord } from '../shared/record'
import { errorMessage } from '../shared/text'
import { createDurableJsonStore } from './durable-json-store'
import { createSerialQueue } from './serial-queue'

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
     * to the plugin's `skills/`; absent when the plugin has no skills or the link failed.
     */
    skillsRoot?: string
    /** The plugin's MCP servers Codex can connect to, its root filled in. */
    mcpServers: PluginMcpServer[]
  }
}

/** What one session launch carries: the usable plugins, and a notice for every one it skipped. */
export interface SessionPlugins {
  plugins: SessionPlugin[]
  notices: string[]
}

/**
 * The plugin registry (#55): `<userData>/plugins.json` behind a durable store, plus the folder reads
 * that decide what a registered plugin is right now. The file only ever says where a plugin lives
 * and which projects enabled it; a plugin's folder is read again every time it matters, so an edit
 * applies to the next session and a folder that went away is noticed where it is used.
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
   * it) carries. Never rejects: a plugin that cannot be used is skipped with a notice, and a registry
   * that cannot be read is one notice, because no plugin is worth a failed launch.
   */
  forSession(request: { provider: AgentProvider; projectPath: string }): Promise<SessionPlugins>
}

export interface PluginRegistryOptions {
  userDataPath: string
  log?: (message: string) => void
}

/**
 * Where Codex finds plugin skills. codex-acp turns every additional directory `D` into the skill
 * root `D/.agents/skills` (`refreshSkills`, codex-acp 2.2.2) and never reads a plugin's own
 * `skills/`, so each plugin gets `<userData>/codex-plugin-skills/<id>/.agents/skills` as a link to
 * it. Codex 0.159.0 follows that link (a junction on Windows) and resolves it to the plugin folder,
 * whose manifest then namespaces the skills `<id>:<skill>` as Claude does.
 */
const CODEX_SKILLS_DIRECTORY = 'codex-plugin-skills'

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
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

type JsonRead = { ok: true; value: unknown } | { ok: false; missing: boolean; error: string }

async function readJson(path: string): Promise<JsonRead> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    return { ok: false, missing: isMissing(error), error: `Could not read ${path}: ${errorMessage(error)}` }
  }
  try {
    return { ok: true, value: JSON.parse(text) as unknown }
  } catch {
    return { ok: false, missing: false, error: `${path} is not valid JSON.` }
  }
}

/** A plugin folder as read now: the validated manifest and the raw object, which Claude reads more of. */
type PluginFolder = { ok: true; manifest: PluginManifest; raw: Record<string, unknown> } | { ok: false; error: string }

async function readPluginFolder(root: string): Promise<PluginFolder> {
  const manifestPath = join(root, ...PLUGIN_MANIFEST_SEGMENTS)
  const read = await readJson(manifestPath)
  if (!read.ok) {
    if (!read.missing) return read
    const folderExists = await stat(root).then(
      () => true,
      (error: unknown) => !isMissing(error)
    )
    return {
      ok: false,
      error: folderExists ? `No plugin manifest at ${manifestPath}.` : `The folder ${root} is missing.`
    }
  }
  const verdict = validatePluginManifest(read.value)
  if (!verdict.ok) return verdict
  // A manifest only validates as an object, so `raw` is always the whole of it.
  return { ...verdict, raw: isRecord(read.value) ? read.value : {} }
}

/**
 * One kind of component configuration as Claude finds it: the default file (`.mcp.json`,
 * `hooks/hooks.json`) first, then whatever the manifest field adds - an inline object, or one or
 * more paths relative to the root. Custom paths supplement the default, as they do for Claude.
 */
async function componentConfigs(
  root: string,
  defaultFile: string,
  declared: unknown
): Promise<{ configs: unknown[]; problems: string[] }> {
  const configs: unknown[] = []
  const problems: string[] = []
  const read = new Set<string>()
  const readConfig = async (path: string, optional: boolean): Promise<void> => {
    if (read.has(pathIdentity(path))) return
    read.add(pathIdentity(path))
    const result = await readJson(path)
    if (result.ok) configs.push(result.value)
    else if (!(optional && result.missing)) problems.push(result.error)
  }
  // Only the default file may be absent; a path the manifest names is expected to exist.
  await readConfig(join(root, defaultFile), true)
  if (isRecord(declared)) configs.push(declared)
  const paths = typeof declared === 'string' ? [declared] : Array.isArray(declared) ? declared : []
  for (const path of paths) if (typeof path === 'string') await readConfig(resolve(root, path), false)
  return { configs, problems }
}

/** One pair of quotes YAML allows around a frontmatter value, which the flat reader keeps. */
function unquoted(value: string | undefined): string | undefined {
  const quoted = value && /^(["'])(.*)\1$/s.exec(value)
  return quoted ? quoted[2] : value || undefined
}

/** Every `skills/<name>/SKILL.md`, named by its frontmatter as Claude names it, else by its folder. */
async function readSkills(root: string): Promise<PluginSkill[]> {
  const directory = join(root, 'skills')
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
  const skills: PluginSkill[] = []
  for (const entry of entries.filter((candidate) => candidate.isDirectory()).sort(byName)) {
    const path = join(directory, entry.name, SKILL_DEFINITION_FILE)
    const text = await readFile(path, 'utf8').catch(() => undefined)
    if (text === undefined) continue
    const { fields } = lenientFrontmatter(text)
    const description = unquoted(fields.get('description'))
    skills.push({ name: unquoted(fields.get('name')) ?? entry.name, ...(description ? { description } : {}), path })
  }
  return skills
}

function byName(left: { name: string }, right: { name: string }): number {
  return left.name < right.name ? -1 : left.name > right.name ? 1 : 0
}

/** More than this many script files are reported as a problem rather than listed in full. */
const SCRIPT_LIMIT = 500

/**
 * Files under the plugin's `scripts/` and each skill's `scripts/`, relative to the root with
 * forward slashes. Links are not followed: a script is what the plugin itself ships.
 */
async function readScripts(root: string, skills: readonly PluginSkill[], problems: string[]): Promise<string[]> {
  const scripts: string[] = []
  const walk = async (directory: string, relative: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
    for (const entry of entries.sort(byName)) {
      if (scripts.length > SCRIPT_LIMIT) return
      if (entry.isDirectory()) await walk(join(directory, entry.name), `${relative}/${entry.name}`)
      else if (entry.isFile()) scripts.push(`${relative}/${entry.name}`)
    }
  }
  await walk(join(root, 'scripts'), 'scripts')
  for (const folder of new Set(skills.map((skill) => basename(dirname(skill.path)))))
    await walk(join(root, 'skills', folder, 'scripts'), `skills/${folder}/scripts`)
  if (scripts.length > SCRIPT_LIMIT) {
    problems.push(`The plugin ships more than ${SCRIPT_LIMIT} script files; only the first ${SCRIPT_LIMIT} are listed.`)
    return scripts.sort().slice(0, SCRIPT_LIMIT)
  }
  return scripts.sort()
}

export function createPluginRegistry(options: PluginRegistryOptions): PluginRegistry {
  const store = createDurableJsonStore<PluginRegistryState>({
    path: join(options.userDataPath, 'plugins.json'),
    parse: parsePluginRegistry,
    fallback: emptyPluginRegistry,
    ...(options.log ? { log: options.log } : {})
  })
  // Two sessions opening together must not race one link into place, or replace it twice.
  const enqueueLink = createSerialQueue()

  /** A registered id as its folder reads now; a manifest that renamed the plugin no longer validates as it. */
  const readRegistered = async (
    id: string,
    path: string
  ): Promise<{ summary: PluginSummary; raw?: Record<string, unknown> }> => {
    const folder = await readPluginFolder(path)
    if (!folder.ok) return { summary: { id, path, problem: folder.error } }
    if (folder.manifest.name !== id)
      return { summary: { id, path, problem: `Its manifest now names it "${folder.manifest.name}".` } }
    return { summary: { id, path, manifest: folder.manifest }, raw: folder.raw }
  }

  /**
   * Points `<userData>/codex-plugin-skills/<id>/.agents/skills` at the plugin's skills. Only ever
   * replaces a link: anything else standing there is not Toucan's to delete.
   */
  const linkCodexSkills = (id: string, skills: string): Promise<string> =>
    enqueueLink(async () => {
      const skillsRoot = join(options.userDataPath, CODEX_SKILLS_DIRECTORY, id)
      const link = join(skillsRoot, PROJECT_SKILLS_DIRECTORY, 'skills')
      const existing = await lstat(link).catch((error: unknown) => {
        if (isMissing(error)) return undefined
        throw error
      })
      if (existing) {
        if (!existing.isSymbolicLink()) throw new Error(`${link} is not a link Toucan made, so it was left alone.`)
        const current = await realpath(link).catch(() => undefined)
        if (current !== undefined && pathIdentity(current) === pathIdentity(await realpath(skills))) return skillsRoot
        await unlink(link)
      }
      await mkdir(dirname(link), { recursive: true })
      await symlink(skills, link, 'junction')
      return skillsRoot
    })

  /** The Codex half of one plugin; every problem is a notice and costs only the part it is about. */
  const codexTranslation = async (
    plugin: { id: string; root: string; raw: Record<string, unknown> },
    claimedServers: Map<string, string>,
    notices: string[]
  ): Promise<NonNullable<SessionPlugin['codex']>> => {
    const notice = (text: string): void => void notices.push(`Plugin "${plugin.id}": ${text}`)
    const mcp = await componentConfigs(plugin.root, '.mcp.json', plugin.raw.mcpServers)
    for (const problem of mcp.problems) notice(`${problem} Codex sessions go without its MCP servers from there.`)
    const mcpServers: PluginMcpServer[] = []
    for (const config of mcp.configs) {
      const { servers, problems } = pluginMcpServers(config, plugin.root)
      for (const problem of problems) notice(problem)
      for (const server of servers) {
        const claimant = claimedServers.get(server.name)
        if (server.transport === 'sse') notice(`MCP server "${server.name}" uses SSE, which Codex cannot connect to.`)
        else if (claimant !== undefined)
          notice(`MCP server "${server.name}" was skipped: plugin "${claimant}" already declares one by that name.`)
        else {
          claimedServers.set(server.name, plugin.id)
          mcpServers.push(server)
        }
      }
    }
    const skills = join(plugin.root, 'skills')
    const hasSkills = await stat(skills).then(
      (entry) => entry.isDirectory(),
      () => false
    )
    if (!hasSkills) return { mcpServers }
    try {
      return { skillsRoot: await linkCodexSkills(plugin.id, skills), mcpServers }
    } catch (error) {
      notice(`its skills could not be offered to Codex: ${errorMessage(error)}`)
      return { mcpServers }
    }
  }

  const sessionPlugins = async (provider: AgentProvider, projectPath: string): Promise<SessionPlugins> => {
    const state = await store.load()
    const plugins: SessionPlugin[] = []
    const notices: string[] = []
    const claimedServers = new Map<string, string>()
    for (const id of enabledIds(state, projectPath)) {
      const entry = own(state.plugins, id)
      const read = entry ? await readRegistered(id, entry.path) : undefined
      if (!read?.raw) {
        notices.push(
          `Plugin "${id}" was skipped for this session. ${read?.summary.problem ?? 'It is enabled but no longer registered.'}`
        )
        continue
      }
      const root = read.summary.path
      plugins.push(
        provider === 'codex'
          ? { id, root, codex: await codexTranslation({ id, root, raw: read.raw }, claimedServers, notices) }
          : { id, root }
      )
    }
    return { plugins, notices }
  }

  return {
    async list(projectPath) {
      const state = await store.load()
      const enabled = projectPath === undefined ? undefined : enabledIds(state, projectPath)
      return Promise.all(
        Object.entries(state.plugins).map(async ([id, entry]) => ({
          ...(await readRegistered(id, entry.path)).summary,
          ...(enabled ? { enabled: enabled.includes(id) } : {})
        }))
      )
    },
    async add(path) {
      if (!isAbsolute(path)) return { ok: false, error: 'A plugin is added by the absolute path of its folder.' }
      const root = resolve(path)
      const folder = await readPluginFolder(root)
      if (!folder.ok) return folder
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
          result: { ok: true, plugin: { id: manifest.name, path: existing?.path ?? root, manifest } }
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
      const state = await store.load()
      const entry = own(state.plugins, id)
      if (!entry) return { ok: false, error: `No plugin named "${id}" is registered.` }
      const read = await readRegistered(id, entry.path)
      if (!read.raw || !read.summary.manifest)
        return { ok: false, error: read.summary.problem ?? `Plugin "${id}" cannot be read.` }
      const root = entry.path
      const problems: string[] = []
      const mcp = await componentConfigs(root, '.mcp.json', read.raw.mcpServers)
      const hookConfigs = await componentConfigs(root, join('hooks', 'hooks.json'), read.raw.hooks)
      problems.push(...mcp.problems, ...hookConfigs.problems)
      const mcpServers: PluginContributions['mcpServers'] = mcp.configs.flatMap((config) => {
        const parsed = pluginMcpServers(config, root)
        problems.push(...parsed.problems)
        return parsed.servers.map((server) => ({
          ...server,
          providers: server.transport === 'sse' ? ['claude'] : ['claude', 'codex']
        }))
      })
      const hooks: PluginContributions['hooks'] = hookConfigs.configs.flatMap((config) => {
        const parsed = pluginHooks(config, root)
        problems.push(...parsed.problems)
        return parsed.hooks.map((hook) => ({ ...hook, providers: ['claude'] }))
      })
      const skills = await readSkills(root)
      const scripts = await readScripts(root, skills, problems)
      return {
        ok: true,
        contributions: { id, root, manifest: read.summary.manifest, skills, scripts, mcpServers, hooks, problems }
      }
    },
    async forSession({ provider, projectPath }) {
      try {
        return await sessionPlugins(provider, projectPath)
      } catch (error) {
        options.log?.(`could not resolve the plugins for ${projectPath}: ${errorMessage(error)}`)
        return { plugins: [], notices: [`Plugins were skipped for this session: ${errorMessage(error)}`] }
      }
    }
  }
}

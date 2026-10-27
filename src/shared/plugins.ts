/**
 * Plugins (#55, plan in `docs/plans/plugins.md`): optional agent-side capabilities - skills, the
 * scripts they call, MCP servers and (Claude only) hooks - that live outside Toucan's code and are
 * enabled per project. A plugin is a folder in Claude's plugin layout, so Claude loads it natively
 * and Toucan adds only what Claude's format lacks: the Codex translation and the Toucan context.
 *
 * Pure, so the rules a plugin is held to read the same in main, which applies them, and in the
 * renderer, which shows their verdicts.
 */

import { isAbsolutePath } from './paths'
import { isRecord } from './record'

/**
 * The project's main checkout, in every session's adapter environment beside `TOUCAN_NODE_ID`: a
 * session's cwd is its worktree, and a plugin script may need the project it belongs to.
 */
export const PROJECT_DIRECTORY_ENV = 'TOUCAN_PROJECT_DIR'

/** The manifest, relative to a plugin's root - Claude's plugin layout. */
export const PLUGIN_MANIFEST_SEGMENTS = ['.claude-plugin', 'plugin.json'] as const

export interface PluginManifest {
  /** The plugin id: unique on this machine, and the namespace Claude gives its skills. */
  name: string
  version: string
  description?: string
}

export type PluginManifestVerdict = { ok: true; manifest: PluginManifest } | { ok: false; error: string }

/**
 * Claude's own rule for a plugin name. It is held strictly because the id also names a folder of
 * Toucan's (the Codex skills root) and a namespace both providers show, so it must be path-safe.
 */
const PLUGIN_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** Semantic Versioning 2.0.0, the regex semver.org gives. */
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/

/**
 * What a `plugin.json` must hold for Toucan to use the folder: a kebab-case `name` and a semver
 * `version` (identity is the pair, never a path). Claude itself requires only the name; the version
 * is Toucan's, for the marketplace the plan keeps possible. Fields Toucan does not read are left to
 * Claude.
 */
export function validatePluginManifest(value: unknown): PluginManifestVerdict {
  if (!isRecord(value)) return { ok: false, error: 'plugin.json must hold a JSON object.' }
  const { name, version, description } = value
  if (typeof name !== 'string' || !PLUGIN_NAME.test(name))
    return {
      ok: false,
      error:
        'plugin.json needs a "name" in kebab-case (lowercase letters, digits and single hyphens), like "godot-runtime".'
    }
  if (typeof version !== 'string' || !SEMVER.test(version))
    return { ok: false, error: 'plugin.json needs a "version" that is a semantic version, like "1.0.0".' }
  return {
    ok: true,
    manifest: { name, version, ...(typeof description === 'string' ? { description } : {}) }
  }
}

/**
 * `<userData>/plugins.json`: where each plugin lives on this machine, and which ids each project
 * enabled. Keyed by the project's main checkout, so a worktree inherits its project's plugins.
 */
export interface PluginRegistryState {
  plugins: Record<string, { path: string }>
  projects: Record<string, string[]>
}

export function emptyPluginRegistry(): PluginRegistryState {
  return { plugins: {}, projects: {} }
}

/**
 * Lenient entry by entry: a hand-edited file with one bad entry keeps every good one, because the
 * next save writes back only what this returned. Ids must be plugin names and project keys absolute
 * paths, which also keeps a `__proto__` key from becoming a prototype.
 */
export function parsePluginRegistry(value: unknown): PluginRegistryState | null {
  if (!isRecord(value)) return null
  const plugins: PluginRegistryState['plugins'] = {}
  for (const [id, entry] of Object.entries(isRecord(value.plugins) ? value.plugins : {})) {
    if (PLUGIN_NAME.test(id) && isRecord(entry) && typeof entry.path === 'string' && isAbsolutePath(entry.path))
      plugins[id] = { path: entry.path }
  }
  const projects: PluginRegistryState['projects'] = {}
  for (const [projectPath, ids] of Object.entries(isRecord(value.projects) ? value.projects : {})) {
    if (!isAbsolutePath(projectPath) || !Array.isArray(ids)) continue
    const enabled = [...new Set(ids.filter((id): id is string => typeof id === 'string' && PLUGIN_NAME.test(id)))]
    if (enabled.length > 0) projects[projectPath] = enabled
  }
  return { plugins, projects }
}

/** A registered plugin as its folder reads right now. */
export interface PluginSummary {
  id: string
  /** The folder the registry points at. */
  path: string
  /** The manifest, while the folder holds one that validates and still names this id. */
  manifest?: PluginManifest
  /** Why the plugin cannot be used right now: its folder is gone or its manifest no longer validates. */
  problem?: string
  /** Whether it is enabled for the project the listing was asked for; absent when none was. */
  enabled?: boolean
}

export type PluginAddResult = { ok: true; plugin: PluginSummary } | { ok: false; error: string }

export type PluginChangeResult = { ok: true } | { ok: false; error: string }

/**
 * The variable Claude expands to a plugin's root in its MCP and hook configuration. Codex knows
 * nothing of it, so every config Toucan translates for Codex has it expanded already.
 */
const PLUGIN_ROOT_VARIABLE = '${CLAUDE_PLUGIN_ROOT}'

/** One MCP server a plugin declares, with the plugin root filled in. */
export type PluginMcpServer =
  | { name: string; transport: 'stdio'; command: string; args: string[]; env: Record<string, string> }
  | { name: string; transport: 'http' | 'sse'; url: string; headers: Record<string, string> }

function withRoot(value: string, root: string): string {
  return value.replaceAll(PLUGIN_ROOT_VARIABLE, root)
}

/** A string-to-string map as written, with the plugin root filled into its values; anything else is dropped. */
function stringMap(value: unknown, root: string): Record<string, string> {
  if (!isRecord(value)) return {}
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, item]) => (typeof item === 'string' ? [[key, withRoot(item, root)]] : []))
  )
}

/**
 * A plugin's MCP configuration (`.mcp.json`, or `mcpServers` inline in `plugin.json`) read the way
 * Claude reads it: a `mcpServers` map or the bare map itself, each entry a command (stdio) or a
 * URL (`http`, `sse`). Claude loads these itself; this is what lets Toucan show them before they
 * are trusted, and hand Codex the same servers.
 */
export function pluginMcpServers(config: unknown, root: string): { servers: PluginMcpServer[]; problems: string[] } {
  if (!isRecord(config)) return { servers: [], problems: ['The MCP configuration must hold a JSON object.'] }
  const map = isRecord(config.mcpServers) ? config.mcpServers : config
  const servers: PluginMcpServer[] = []
  const problems: string[] = []
  for (const [name, entry] of Object.entries(map)) {
    const server = isRecord(entry) ? entry : {}
    const type = typeof server.type === 'string' ? server.type : undefined
    if ((type === undefined || type === 'stdio') && typeof server.command === 'string') {
      servers.push({
        name,
        transport: 'stdio',
        command: withRoot(server.command, root),
        args: Array.isArray(server.args)
          ? server.args.filter((arg): arg is string => typeof arg === 'string').map((arg) => withRoot(arg, root))
          : [],
        env: stringMap(server.env, root)
      })
    } else if ((type === undefined || type === 'http' || type === 'sse') && typeof server.url === 'string') {
      servers.push({
        name,
        transport: type === 'sse' ? 'sse' : 'http',
        url: withRoot(server.url, root),
        headers: stringMap(server.headers, root)
      })
    } else if (type !== undefined && type !== 'stdio' && type !== 'http' && type !== 'sse') {
      problems.push(`MCP server "${name}" uses the "${type}" transport, which Toucan cannot read.`)
    } else {
      problems.push(`MCP server "${name}" names neither a command nor a URL.`)
    }
  }
  return { servers, problems }
}

/**
 * The line a session gets per enabled plugin. A plugin's skills name their scripts as
 * `<root>/scripts/...`, the same text for both providers, and this is what resolves `<root>`.
 */
export function pluginInstruction(plugins: ReadonlyArray<{ id: string; root: string }>): string | undefined {
  if (plugins.length === 0) return undefined
  return plugins
    .map(
      ({ id, root }) =>
        `Toucan plugin "${id}" is enabled for this project: its root is ${root}, which is what <root> means in its skills.`
    )
    .join('\n')
}

import type { Dirent } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { lenientFrontmatter } from '../shared/frontmatter'
import { pathIdentity } from '../shared/paths'
import {
  PLUGIN_MANIFEST_SEGMENTS,
  pluginHooks,
  pluginMcpServers,
  reachesCodex,
  validatePluginManifest,
  type PluginContributions,
  type PluginManifest,
  type PluginMcpServer,
  type PluginSkill
} from '../shared/plugins'
import { SKILL_DEFINITION_FILE } from '../shared/project-skills'
import { isRecord } from '../shared/record'
import { errorMessage } from '../shared/text'

/**
 * One plugin folder (#55) read the way Claude reads it: the manifest, the MCP and hook
 * configurations, the skills and the scripts. Never cached - a plugin is a folder used in place, so
 * every read sees the folder as it is now.
 */

/** A plugin folder as read now: the validated manifest and the raw object, which Claude reads more of. */
export type PluginFolder =
  { ok: true; manifest: PluginManifest; raw: Record<string, unknown> } | { ok: false; problem: string }

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
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

export async function readPluginFolder(root: string): Promise<PluginFolder> {
  const manifestPath = join(root, ...PLUGIN_MANIFEST_SEGMENTS)
  const read = await readJson(manifestPath)
  if (!read.ok) {
    if (!read.missing) return { ok: false, problem: read.error }
    const folderExists = await stat(root).then(
      () => true,
      (error: unknown) => !isMissing(error)
    )
    return {
      ok: false,
      problem: folderExists ? `No plugin manifest at ${manifestPath}.` : `The folder ${root} is missing.`
    }
  }
  const verdict = validatePluginManifest(read.value)
  if (!verdict.ok) return { ok: false, problem: verdict.error }
  // A manifest only validates as an object, so `raw` is always the whole of it.
  return { ok: true, manifest: verdict.manifest, raw: isRecord(read.value) ? read.value : {} }
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

/** Every MCP server the plugin declares, from `.mcp.json` and its manifest, its root filled in. */
export async function readPluginMcpServers(
  root: string,
  raw: Record<string, unknown>
): Promise<{ servers: PluginMcpServer[]; problems: string[] }> {
  const { configs, problems } = await componentConfigs(root, '.mcp.json', raw.mcpServers)
  const servers = configs.flatMap((config) => {
    const parsed = pluginMcpServers(config, root)
    problems.push(...parsed.problems)
    return parsed.servers
  })
  return { servers, problems }
}

/** What a directory entry is once a link is followed; a link to nothing is `broken`. */
async function entryKind(directory: string, entry: Dirent): Promise<'file' | 'directory' | 'broken' | 'other'> {
  if (!entry.isSymbolicLink()) return entry.isFile() ? 'file' : entry.isDirectory() ? 'directory' : 'other'
  return stat(join(directory, entry.name)).then(
    (target) => (target.isFile() ? 'file' : target.isDirectory() ? 'directory' : 'other'),
    () => 'broken'
  )
}

function byName(left: { name: string }, right: { name: string }): number {
  return left.name < right.name ? -1 : left.name > right.name ? 1 : 0
}

async function entries(directory: string): Promise<Dirent[]> {
  return (await readdir(directory, { withFileTypes: true }).catch(() => [])).sort(byName)
}

/** One pair of quotes YAML allows around a frontmatter value, which the flat reader keeps. */
function unquoted(value: string | undefined): string | undefined {
  const quoted = value && /^(["'])(.*)\1$/s.exec(value)
  return quoted ? quoted[2] : value || undefined
}

/**
 * Every `skills/<folder>/SKILL.md`, named by its frontmatter as Claude names it, else by its folder.
 * A linked skill folder counts, as it does for Claude; a link to nothing is a problem.
 */
async function readSkills(root: string, problems: string[]): Promise<Array<PluginSkill & { folder: string }>> {
  const directory = join(root, 'skills')
  const skills: Array<PluginSkill & { folder: string }> = []
  for (const entry of await entries(directory)) {
    const kind = await entryKind(directory, entry)
    if (kind === 'broken') problems.push(`skills/${entry.name} is a link to something that is gone.`)
    if (kind !== 'directory') continue
    const path = join(directory, entry.name, SKILL_DEFINITION_FILE)
    const text = await readFile(path, 'utf8').catch(() => undefined)
    if (text === undefined) continue
    const { fields } = lenientFrontmatter(text)
    const description = unquoted(fields.get('description'))
    skills.push({
      name: unquoted(fields.get('name')) ?? entry.name,
      ...(description ? { description } : {}),
      path,
      folder: entry.name
    })
  }
  return skills
}

/** More than this many script files are reported as a problem rather than listed in full. */
const SCRIPT_LIMIT = 500
/** Deep enough for any real layout; bounds a linked folder that leads back to an ancestor. */
const SCRIPT_DEPTH = 8

/**
 * Files under the plugin's `scripts/` and each skill's `scripts/`, relative to the root with forward
 * slashes. A linked file or folder is followed, because a skill can run it all the same.
 */
async function readScripts(root: string, skillFolders: readonly string[], problems: string[]): Promise<string[]> {
  const scripts: string[] = []
  const walk = async (directory: string, relative: string, depth: number): Promise<void> => {
    for (const entry of await entries(directory)) {
      if (scripts.length > SCRIPT_LIMIT) return
      const path = `${relative}/${entry.name}`
      const kind = await entryKind(directory, entry)
      if (kind === 'file') scripts.push(path)
      else if (kind === 'broken') problems.push(`${path} is a link to something that is gone.`)
      else if (kind === 'directory' && depth < SCRIPT_DEPTH) await walk(join(directory, entry.name), path, depth + 1)
    }
  }
  await walk(join(root, 'scripts'), 'scripts', 0)
  for (const folder of new Set(skillFolders))
    await walk(join(root, 'skills', folder, 'scripts'), `skills/${folder}/scripts`, 0)
  scripts.sort()
  if (scripts.length <= SCRIPT_LIMIT) return scripts
  problems.push(`The plugin ships more than ${SCRIPT_LIMIT} script files; only the first ${SCRIPT_LIMIT} are listed.`)
  return scripts.slice(0, SCRIPT_LIMIT)
}

/** What the folder contributes, for the trust step; every unreadable part is a problem, never a silent gap. */
export async function readPluginContributions(
  id: string,
  root: string,
  folder: { manifest: PluginManifest; raw: Record<string, unknown> }
): Promise<PluginContributions> {
  const mcp = await readPluginMcpServers(root, folder.raw)
  const hookConfigs = await componentConfigs(root, join('hooks', 'hooks.json'), folder.raw.hooks)
  const problems = [...mcp.problems, ...hookConfigs.problems]
  const hooks = hookConfigs.configs.flatMap((config) => {
    const parsed = pluginHooks(config, root)
    problems.push(...parsed.problems)
    return parsed.hooks
  })
  const skills = await readSkills(root, problems)
  const scripts = await readScripts(
    root,
    skills.map((skill) => skill.folder),
    problems
  )
  return {
    id,
    root,
    manifest: folder.manifest,
    skills: skills.map(({ folder: _folder, ...skill }) => skill),
    scripts,
    mcpServers: mcp.servers.map((server) => ({
      ...server,
      providers: reachesCodex(server) ? ['claude', 'codex'] : ['claude']
    })),
    hooks: hooks.map((hook) => ({ ...hook, providers: ['claude'] })),
    problems
  }
}

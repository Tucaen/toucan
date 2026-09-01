import { link, mkdir, readFile, readdir, rename, rm, unlink } from 'node:fs/promises'
import { isAbsolute, join, normalize, win32 } from 'node:path'
import type {
  BrainDumpLibraryApi,
  BrainDumpCollection,
  BrainDumpListResult,
  BrainDumpMutationResult,
  BrainDumpOutcome,
  BrainDumpReferenceResult,
  BrainDumpTopic
} from '../shared/brain-dump'
import { BRAIN_DUMP_OUTCOMES, isBrainDumpSlug } from '../shared/brain-dump'
import { pathExists, syncPromotedFile, writeNewFileDurably } from './durable-file'

export interface BrainDumpLibraryOptions {
  rootDirectory: string
  today: () => string
}

interface ParsedDocument {
  fields: Map<string, string>
  lines: string[]
  closing: number
}

function parseDocument(markdown: string): ParsedDocument {
  const lines = markdown.split('\n')
  if (lines[0] !== '---') throw new Error('Topic must start with YAML frontmatter.')
  const closing = lines.indexOf('---', 1)
  if (closing < 0) throw new Error('Topic frontmatter must have a closing --- delimiter.')
  const fields = new Map<string, string>()
  for (let index = 1; index < closing; index += 1) {
    const match = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*?)\s*$/.exec(lines[index])
    if (!match) {
      if (/^(?:\s|#|$)/.test(lines[index])) continue
      throw new Error(`Invalid frontmatter line ${index + 1}.`)
    }
    if (fields.has(match[1])) throw new Error(`Duplicate frontmatter field "${match[1]}".`)
    fields.set(match[1], match[2])
  }
  return { fields, lines, closing }
}

function date(value: string | undefined, name: string): string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`${name} must use YYYY-MM-DD.`)
  return value
}

function projectPath(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  let decoded = value
  if (value.startsWith('"')) {
    try {
      decoded = JSON.parse(value) as string
    } catch {
      throw new Error('project must be a valid quoted path with escaped backslashes.')
    }
  }
  if (typeof decoded !== 'string' || (!isAbsolute(decoded) && !win32.isAbsolute(decoded))) {
    throw new Error('project must be an absolute directory path.')
  }
  return win32.isAbsolute(decoded) ? win32.normalize(decoded) : normalize(decoded)
}

export function parseBrainDumpTopic(markdown: string, slug: string, collection: BrainDumpCollection): BrainDumpTopic {
  const { fields } = parseDocument(markdown)
  const title = fields.get('title')?.trim()
  if (!title) throw new Error('title is required.')
  const created = date(fields.get('created'), 'created')
  const updated = date(fields.get('updated'), 'updated')
  const outcome = fields.get('outcome')
  const archived = fields.get('archived')
  const assignedProjectPath = projectPath(fields.get('project'))
  if (collection === 'active' && (outcome !== undefined || archived !== undefined))
    throw new Error('Active topics must not contain outcome or archived.')
  if (collection === 'archived') {
    if (!BRAIN_DUMP_OUTCOMES.includes(outcome as BrainDumpOutcome)) throw new Error('Archived outcome is invalid.')
    date(archived, 'archived')
  }
  return {
    slug,
    title,
    created,
    updated,
    collection,
    ...(assignedProjectPath ? { projectPath: assignedProjectPath } : {}),
    ...(outcome ? { outcome: outcome as BrainDumpOutcome } : {}),
    ...(archived ? { archived } : {}),
    markdown
  }
}

function mutateFrontmatter(markdown: string, updates: Record<string, string | undefined>): string {
  const parsed = parseDocument(markdown)
  const remaining = new Map(Object.entries(updates))
  const output = [parsed.lines[0]]
  for (let index = 1; index < parsed.closing; index += 1) {
    const key = /^([A-Za-z][A-Za-z0-9_-]*):/.exec(parsed.lines[index])?.[1]
    if (key && remaining.has(key)) {
      const value = remaining.get(key)
      if (value !== undefined) output.push(`${key}: ${value}`)
      remaining.delete(key)
    } else output.push(parsed.lines[index])
  }
  for (const [key, value] of remaining) if (value !== undefined) output.push(`${key}: ${value}`)
  output.push(...parsed.lines.slice(parsed.closing))
  return output.join('\n')
}

export function createBrainDumpLibrary(options: BrainDumpLibraryOptions): BrainDumpLibraryApi {
  const directory = (collection: BrainDumpCollection): string => join(options.rootDirectory, collection)
  const pathFor = (collection: BrainDumpCollection, slug: string): string => join(directory(collection), `${slug}.md`)
  let mutations = Promise.resolve()

  async function readTopic(collection: BrainDumpCollection, slug: string): Promise<BrainDumpTopic> {
    return parseBrainDumpTopic(await readFile(pathFor(collection, slug), 'utf8'), slug, collection)
  }

  async function list(collection: BrainDumpCollection): Promise<BrainDumpListResult> {
    let entries
    try {
      entries = await readdir(directory(collection), { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { topics: [], diagnostics: [] }
      throw error
    }
    const topics: BrainDumpTopic[] = []
    const diagnostics: BrainDumpListResult['diagnostics'] = []
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue
      const slug = entry.name.slice(0, -3)
      const path = pathFor(collection, slug)
      try {
        if (!isBrainDumpSlug(slug)) throw new Error('Filename must be a lowercase kebab-case slug.')
        topics.push(await readTopic(collection, slug))
      } catch (error) {
        diagnostics.push({ path, code: 'malformed-topic', message: (error as Error).message })
      }
    }
    topics.sort((left, right) => right.updated.localeCompare(left.updated) || left.title.localeCompare(right.title))
    diagnostics.sort((left, right) => left.path.localeCompare(right.path))
    return { topics, diagnostics }
  }

  async function resolve(slug: string): Promise<BrainDumpReferenceResult> {
    if (!isBrainDumpSlug(slug)) return { status: 'invalid', slug }
    const [activeExists, archivedExists] = await Promise.all([
      pathExists(pathFor('active', slug)),
      pathExists(pathFor('archived', slug))
    ])
    if (activeExists && archivedExists) return { status: 'conflict', slug }
    if (!activeExists && !archivedExists) return { status: 'missing', slug }
    const collection = activeExists ? 'active' : 'archived'
    try {
      return { status: 'found', slug, collection, topic: await readTopic(collection, slug) }
    } catch (error) {
      return { status: 'invalid-topic', slug, collection, message: (error as Error).message }
    }
  }

  function serialized(operation: () => Promise<BrainDumpMutationResult>): Promise<BrainDumpMutationResult> {
    const result = mutations.then(operation, operation)
    mutations = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  /**
   * Reads a topic, applies `updates` to its frontmatter, and proves the result is still a valid
   * topic of `destinationCollection` before anything is written. Throws when either end fails to
   * parse, so no mutation can leave behind a file the library would not have accepted.
   */
  async function rewritten(
    slug: string,
    sourceCollection: BrainDumpCollection,
    destinationCollection: BrainDumpCollection,
    updates: Record<string, string | undefined>
  ): Promise<string> {
    const markdown = await readFile(pathFor(sourceCollection, slug), 'utf8')
    parseBrainDumpTopic(markdown, slug, sourceCollection)
    const transformed = mutateFrontmatter(markdown, updates)
    parseBrainDumpTopic(transformed, slug, destinationCollection)
    return transformed
  }

  /**
   * Writes `contents` beside its destination and hands the finished temp file to `promote`, which
   * is the only thing the two mutation shapes disagree about: a move between collections must
   * refuse a destination that already exists, an in-place rewrite must replace one. A failure at
   * any point leaves no temp file behind and the destination as it was.
   */
  async function writeThroughTemporary(
    collection: BrainDumpCollection,
    slug: string,
    contents: string,
    promote: (temporary: string, destination: string) => Promise<void>
  ): Promise<void> {
    const folder = directory(collection)
    const destination = pathFor(collection, slug)
    await mkdir(folder, { recursive: true })
    const temporary = join(folder, `.${slug}.${process.pid}.${Date.now()}.tmp`)
    try {
      await writeNewFileDurably(temporary, contents)
      await promote(temporary, destination)
      await syncPromotedFile(destination, folder)
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {})
      throw error
    }
  }

  async function move(
    slug: string,
    sourceCollection: BrainDumpCollection,
    destinationCollection: BrainDumpCollection,
    updates: Record<string, string | undefined>
  ): Promise<BrainDumpMutationResult> {
    if (!isBrainDumpSlug(slug))
      return { ok: false, code: 'invalid-slug', message: 'Slug must be lowercase kebab-case.' }
    const source = pathFor(sourceCollection, slug)
    if (!(await pathExists(source)))
      return { ok: false, code: 'missing-source', message: `${sourceCollection} topic does not exist.` }
    if (await pathExists(pathFor(destinationCollection, slug)))
      return { ok: false, code: 'destination-exists', message: 'The slug exists in both collections.' }
    let transformed: string
    try {
      transformed = await rewritten(slug, sourceCollection, destinationCollection, updates)
    } catch (error) {
      return { ok: false, code: 'malformed-source', message: (error as Error).message }
    }
    try {
      await writeThroughTemporary(destinationCollection, slug, transformed, async (temporary, destination) => {
        // A hard-link promotion is atomic and refuses an externally-created destination. A plain
        // rename would overwrite on POSIX, defeating the conflict guarantee between check and move.
        await link(temporary, destination)
        await unlink(temporary)
      })
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code === 'EEXIST' ? 'destination-exists' : 'write-failed'
      return { ok: false, code, message: (error as Error).message }
    }
    try {
      await unlink(source)
    } catch (error) {
      return { ok: false, code: 'source-removal-conflict', message: (error as Error).message }
    }
    return { ok: true, topic: parseBrainDumpTopic(transformed, slug, destinationCollection) }
  }

  /**
   * Rewrites an active topic's frontmatter in place. Unlike `move` the destination is the file
   * itself, so promotion is a replacing rename - the conflict guarantee `move` needs between two
   * collections has no meaning when there is only one path involved.
   */
  async function updateActive(
    slug: string,
    updates: Record<string, string | undefined>
  ): Promise<BrainDumpMutationResult> {
    if (!isBrainDumpSlug(slug))
      return { ok: false, code: 'invalid-slug', message: 'Slug must be lowercase kebab-case.' }
    if (!(await pathExists(pathFor('active', slug))))
      return { ok: false, code: 'missing-source', message: 'active topic does not exist.' }
    let transformed: string
    try {
      transformed = await rewritten(slug, 'active', 'active', updates)
    } catch (error) {
      return { ok: false, code: 'malformed-source', message: (error as Error).message }
    }
    try {
      await writeThroughTemporary('active', slug, transformed, (temporary, destination) =>
        rename(temporary, destination)
      )
    } catch (error) {
      return { ok: false, code: 'write-failed', message: (error as Error).message }
    }
    return { ok: true, topic: parseBrainDumpTopic(transformed, slug, 'active') }
  }

  return {
    list,
    resolve,
    assignProject: (slug, path) =>
      serialized(async () => {
        let field: string | undefined
        if (path !== undefined) {
          try {
            field = JSON.stringify(projectPath(path))
          } catch (error) {
            return { ok: false, code: 'invalid-project', message: (error as Error).message }
          }
        }
        if (isBrainDumpSlug(slug) && !(await pathExists(pathFor('active', slug)))) {
          if (await pathExists(pathFor('archived', slug)))
            return {
              ok: false,
              code: 'immutable-archive',
              message: 'Archived topics are immutable snapshots; assign a project before archiving.'
            }
        }
        // The project is metadata about where the topic belongs, not new material in it, so
        // `updated` deliberately stays where the last real write left it.
        return updateActive(slug, { project: field })
      }),
    archive: (slug, outcome) =>
      serialized(async () => {
        if (!BRAIN_DUMP_OUTCOMES.includes(outcome))
          return { ok: false, code: 'invalid-outcome', message: 'Outcome is not supported.' }
        const today = options.today()
        return move(slug, 'active', 'archived', { updated: today, outcome, archived: today })
      })
  }
}

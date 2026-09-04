import { mkdir, readFile, readdir, rename, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { rewriteFrontmatter } from '../shared/frontmatter'
import type { TicketMutationResult, TicketRemovalResult, TicketSourceListResult } from '../shared/ticket-source'
import { ticketCard } from '../shared/ticket-source'
import type { Ticket, TicketDiagnostic } from '../shared/tickets'
import { isTicketSlug, isTicketStatus, parseTicket } from '../shared/tickets'
import { syncPromotedFile, writeNewFileDurably } from './durable-file'

/**
 * The files ticket source: it reads and writes the Markdown files in a project's tickets folder,
 * and it is the only thing in Toucan that touches them. The files are the truth, so nothing here
 * caches a ticket between calls - every listing is a fresh read of the folder, which is what lets
 * an agent, an editor and the board all write the same folder without a reconciliation step.
 *
 * Deliberately not built on `brain-dump-library.ts`: that module knows about two collections, an
 * immutable archive and capture jobs, none of which a ticket has. The shape is copied; the code is
 * not shared. What *is* shared is `shared/frontmatter.ts`, through `parseTicket`.
 */

export interface TicketLibraryOptions {
  /** Where this project keeps its tickets; resolving it may need the workspace snapshot. */
  directoryFor(projectPath: string): string | Promise<string>
  /** Today as `YYYY-MM-DD`, in the user's own calendar. */
  today(): string
}

export interface TicketLibrary {
  list(projectPath: string): Promise<TicketSourceListResult>
  setStatus(projectPath: string, slug: string, status: string): Promise<TicketMutationResult>
  /**
   * Deletes the ticket file. There is no archive folder and no trash: every Toucan project is a git
   * checkout, so history is the backup, and a deleted slug someone still names in `blocked_by`
   * shows as the board's existing "missing" chip rather than a third blocker state.
   */
  remove(projectPath: string, slug: string): Promise<TicketRemovalResult>
  /** The file behind a slug, or `null` when the slug is not one - never an unchecked join. */
  pathFor(projectPath: string, slug: string): Promise<string | null>
}

export function createTicketLibrary(options: TicketLibraryOptions): TicketLibrary {
  // Serialized so two drops in quick succession cannot interleave a read with the other's write.
  let mutations = Promise.resolve()

  async function pathFor(projectPath: string, slug: string): Promise<string | null> {
    if (!isTicketSlug(slug)) return null
    return join(await options.directoryFor(projectPath), `${slug}.md`)
  }

  async function list(projectPath: string): Promise<TicketSourceListResult> {
    const folder = await options.directoryFor(projectPath)
    let entries
    try {
      entries = await readdir(folder, { withFileTypes: true })
    } catch (error) {
      // A project that has never filed a ticket is not an error; it is a project with no tickets.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { cards: [], diagnostics: [] }
      throw error
    }
    const cards: TicketSourceListResult['cards'] = []
    const diagnostics: TicketDiagnostic[] = []
    for (const entry of entries) {
      // Only direct `.md` children are tickets, exactly as the `tickets` skill promises. A
      // durable-write temporary is a dotfile, so it is skipped rather than reported as broken.
      if (!entry.isFile() || !entry.name.endsWith('.md') || entry.name.startsWith('.')) continue
      const path = join(folder, entry.name)
      try {
        cards.push(ticketCard(parseTicket(await readFile(path, 'utf8'), entry.name.slice(0, -3))))
      } catch (error) {
        diagnostics.push({ path, code: 'malformed-ticket', message: (error as Error).message })
      }
    }
    diagnostics.sort((left, right) => left.path.localeCompare(right.path))
    return { cards, diagnostics }
  }

  /**
   * Writes beside the destination and promotes with a replacing rename, so a reader either sees
   * the file as it was or as it now is - never a half-written one - and a failure anywhere leaves
   * the folder exactly as it was found.
   */
  async function writeThroughTemporary(folder: string, slug: string, contents: string): Promise<void> {
    const destination = join(folder, `${slug}.md`)
    await mkdir(folder, { recursive: true })
    const temporary = join(folder, `.${slug}.${process.pid}.${Date.now()}.tmp`)
    try {
      await writeNewFileDurably(temporary, contents)
      await rename(temporary, destination)
      await syncPromotedFile(destination, folder)
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {})
      throw error
    }
  }

  /**
   * Path identity rather than string equality: what may be deleted is a direct `.md` child of this
   * project's tickets folder, decided by resolving both ends - so no slug, however it was spelled
   * or normalized on the way in, can name a file anywhere else.
   */
  async function applyRemove(projectPath: string, slug: string): Promise<TicketRemovalResult> {
    if (!isTicketSlug(slug)) return { ok: false, code: 'invalid-slug', message: 'Slug must be lowercase kebab-case.' }
    const folder = await options.directoryFor(projectPath)
    const path = resolve(folder, `${slug}.md`)
    if (dirname(path) !== resolve(folder))
      return { ok: false, code: 'invalid-slug', message: 'A ticket is a file directly in the tickets folder.' }
    try {
      // `force` because a ticket that is already gone is the outcome the caller asked for: a bulk
      // delete racing the watcher must not fail on a file someone else removed a moment earlier.
      await rm(path, { force: true })
    } catch (error) {
      return { ok: false, code: 'delete-failed', message: (error as Error).message }
    }
    return { ok: true }
  }

  async function applyStatus(projectPath: string, slug: string, status: string): Promise<TicketMutationResult> {
    if (!isTicketSlug(slug)) return { ok: false, code: 'invalid-slug', message: 'Slug must be lowercase kebab-case.' }
    if (!isTicketStatus(status))
      return { ok: false, code: 'invalid-status', message: 'Status must be one lowercase kebab-case word.' }
    const folder = await options.directoryFor(projectPath)
    const path = join(folder, `${slug}.md`)
    let markdown: string
    try {
      markdown = await readFile(path, 'utf8')
    } catch (error) {
      return { ok: false, code: 'missing-ticket', message: (error as Error).message }
    }
    // Both ends are parsed before anything is written, so a mutation can never leave behind a file
    // this library would refuse to read back - and a file someone broke by hand is left alone.
    let rewritten: Ticket
    let contents: string
    try {
      parseTicket(markdown, slug)
      contents = rewriteFrontmatter(markdown, { status, updated: options.today() })
      rewritten = parseTicket(contents, slug)
    } catch (error) {
      return { ok: false, code: 'malformed-source', message: (error as Error).message }
    }
    try {
      await writeThroughTemporary(folder, slug, contents)
    } catch (error) {
      return { ok: false, code: 'write-failed', message: (error as Error).message }
    }
    return { ok: true, card: ticketCard(rewritten) }
  }

  /** Every write queues behind every other one, so no two of them interleave a read with a write. */
  function serialized<T>(apply: () => Promise<T>): Promise<T> {
    const result = mutations.then(apply, apply)
    mutations = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  return {
    list,
    pathFor,
    setStatus: (projectPath, slug, status) => serialized(() => applyStatus(projectPath, slug, status)),
    remove: (projectPath, slug) => serialized(() => applyRemove(projectPath, slug))
  }
}

import { mkdir, readFile, readdir, rename, rm, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { upsertFrontmatter } from '../shared/frontmatter'
import type { TicketMutationResult, TicketRemovalResult, TicketSourceListResult } from '../shared/ticket-source'
import { EMPTY_TICKET_LISTING, ticketCard } from '../shared/ticket-source'
import { errorMessage } from '../shared/text'
import type { Ticket, TicketDiagnostic } from '../shared/tickets'
import { isTicketSlug, isTicketStatus, readTicket } from '../shared/tickets'
import { syncPromotedFile, writeNewFileDurably } from './durable-file'

/**
 * The files ticket source: it reads and writes the Markdown files in a project's tickets folder,
 * and it is the only thing in Toucan that touches them. The files are the truth, so nothing here
 * caches a ticket between calls - every listing is a fresh read of the folder, which is what lets
 * an agent, an editor and the board all write the same folder without a reconciliation step.
 *
 * Deliberately not built on `brain-dump-library.ts`: that module knows about two collections, an
 * immutable archive and capture jobs, none of which a ticket has. The shape is copied; the code is
 * not shared. What *is* shared is `shared/frontmatter.ts` - through `readTicket` when listing, and
 * through `upsertFrontmatter` when writing a status back.
 *
 * Reading a file here cannot fail (see `shared/tickets.ts`), so the only diagnostics this source
 * ever produces are about the file rather than its contents: a name that is not an id, or bytes it
 * could not get off disk.
 */

export interface TicketLibraryOptions {
  /** Where this project keeps its tickets; resolving it may need the workspace snapshot. */
  directoryFor(projectPath: string): string | Promise<string>
  /** Today as `YYYY-MM-DD`, in the user's own calendar. */
  today(): string
}

export interface TicketLibrary {
  list(projectPath: string): Promise<TicketSourceListResult>
  /**
   * One ticket, read fresh from its file, or `null` when the slug names no file - or nothing this
   * library may open. Whatever the file contains, it reads as a ticket: see `shared/tickets.ts`.
   */
  read(projectPath: string, slug: string): Promise<Ticket | null>
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

  function isMissing(error: unknown): boolean {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
  }

  async function read(projectPath: string, slug: string): Promise<Ticket | null> {
    const path = await pathFor(projectPath, slug)
    if (!path) return null
    let markdown: string
    try {
      markdown = await readFile(path, 'utf8')
    } catch (error) {
      if (isMissing(error)) return null
      throw error
    }
    return readTicket(markdown, slug)
  }

  async function list(projectPath: string): Promise<TicketSourceListResult> {
    const folder = await options.directoryFor(projectPath)
    let entries
    try {
      entries = await readdir(folder, { withFileTypes: true })
    } catch (error) {
      // A project that has never filed a ticket is not an error; it is a project with no tickets.
      if (isMissing(error)) return EMPTY_TICKET_LISTING
      throw error
    }
    const cards: TicketSourceListResult['cards'] = []
    const diagnostics: TicketDiagnostic[] = []
    for (const entry of entries) {
      // Only direct `.md` children are tickets, exactly as the `tickets` skill promises. A
      // durable-write temporary is a dotfile, so it is skipped rather than reported as broken.
      if (!entry.isFile() || !entry.name.endsWith('.md') || entry.name.startsWith('.')) continue
      const path = join(folder, entry.name)
      const slug = entry.name.slice(0, -3)
      // The one thing leniency cannot bridge: the filename *is* the id, so a file named anything
      // else has nothing for `blocked_by`, a drop or a delete to address it by.
      if (!isTicketSlug(slug)) {
        diagnostics.push({ path, code: 'unusable-filename', message: 'Filename must be a lowercase kebab-case slug.' })
        continue
      }
      try {
        // mtime alongside the bytes, because a file that wrote no `updated` still has to sort
        // somewhere, and when it last changed on disk is the only honest answer available.
        const [markdown, stats] = await Promise.all([readFile(path, 'utf8'), stat(path)])
        cards.push(ticketCard(readTicket(markdown, slug), stats.mtimeMs))
      } catch (error) {
        diagnostics.push({ path, code: 'unreadable-ticket', message: errorMessage(error) })
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
      return { ok: false, code: 'delete-failed', message: errorMessage(error) }
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
      return { ok: false, code: 'missing-ticket', message: errorMessage(error) }
    }
    // A card the board is willing to show is a card the board must be able to move, so a file
    // with no frontmatter gets one written above the text it already had rather than refusing the
    // drop. Nothing below the closing delimiter is touched, whatever shape the prose is in. The
    // single exception is a file the write would take a field away from, which is refused with
    // the writer's own reason: the drop fails and the file is not opened for writing at all.
    const upserted = upsertFrontmatter(markdown, { status, updated: options.today() })
    if (!upserted.ok) return { ok: false, code: 'unwritable-frontmatter', message: upserted.message }
    const contents = upserted.markdown
    const rewritten: Ticket = readTicket(contents, slug)
    try {
      await writeThroughTemporary(folder, slug, contents)
    } catch (error) {
      return { ok: false, code: 'write-failed', message: errorMessage(error) }
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
    read,
    pathFor,
    setStatus: (projectPath, slug, status) => serialized(() => applyStatus(projectPath, slug, status)),
    remove: (projectPath, slug) => serialized(() => applyRemove(projectPath, slug))
  }
}

import { lenientFrontmatter } from './frontmatter'
import { isAbsolutePath } from './paths'

/**
 * A ticket is a Markdown file in a project's tickets folder, and the file is the truth: Toucan
 * renders and mutates those files but never keeps a second copy of ticket state. This module is
 * the only place that decides what one of those files says, so the board, the agent-facing
 * `tickets` skill and any future source all agree. Pure: no filesystem, no Node.
 *
 * Reading is deliberately *lenient*: a tickets folder is a notepad before it is a tracker, so
 * every `.md` file in it becomes a card and nothing here can reject one. Each field that is
 * missing, blank or misspelled falls back to something the file itself supports - a heading for a
 * title, the default column for a status - with one exception that is never bridged: a date is
 * shown only when the file carries a real one, because an invented date is a lie a board tells
 * every time it is read. Ordering a dateless card is the *source's* problem (the files source
 * uses the file's mtime), not something guessed here.
 */

/** The statuses Toucan ships columns for. A project may invent more; see `Ticket.status`. */
export type TicketStatus = 'open' | 'in-progress' | 'blocked' | 'done'

/**
 * The shipped statuses by name, so a rule about "done" reads as one rather than as a string that
 * happens to match the file convention.
 */
export const TICKET_STATUS = {
  open: 'open',
  inProgress: 'in-progress',
  blocked: 'blocked',
  done: 'done'
} as const satisfies Record<string, TicketStatus>

/** Board order, left to right. `done` last because the Done column is collapsed by default. */
export const DEFAULT_TICKET_STATUSES: readonly TicketStatus[] = [
  TICKET_STATUS.open,
  TICKET_STATUS.inProgress,
  TICKET_STATUS.blocked,
  TICKET_STATUS.done
]

/** Relative to the project root, unless the project sets `ticketsDirectory`. */
export const DEFAULT_TICKETS_DIRECTORY = 'docs/tickets'

export interface Ticket {
  /** The filename without `.md`; unique in the folder, and how `blocked_by` references a ticket. */
  slug: string
  title: string
  /**
   * One of `DEFAULT_TICKET_STATUSES`, or any other word the project invented — an unknown status
   * is tolerated and becomes an extra board column rather than a reason to reject the file.
   */
  status: string
  /** Absent when the file carries no usable `created`; never filled in with a guess. */
  created?: string
  /** Absent when the file carries no usable `updated`; never filled in with a guess. */
  updated?: string
  /**
   * What `blocked_by` named, deduplicated, in first-mention order, minus the ticket itself. Kept
   * as written rather than filtered to slugs: an entry no ticket in the folder answers to is the
   * board's existing flagged chip, which is how a typo stays visible instead of disappearing.
   */
  blockedBy: string[]
  /** Everything after the frontmatter, verbatim. */
  body: string
  markdown: string
}

/**
 * Why one file in the tickets folder could not be shown at all. Listed on the board, never
 * dropped - but rare by design: reading is lenient, so this is left for a file whose *name* is
 * not an id (`blocked_by` and every link point at the filename) or one that could not be read off
 * disk. A file Toucan can open and whose name is a slug always becomes a card instead.
 */
export interface TicketDiagnostic {
  path: string
  code: string
  message: string
}

/** The filename minus `.md`, and so also how `blocked_by` names a ticket. */
export function isTicketSlug(value: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)
}

function field(fields: Map<string, string>, name: string): string | undefined {
  return fields.get(name)?.trim() || undefined
}

/** A date the file genuinely carries, or nothing: any other spelling is treated as unwritten. */
function date(fields: Map<string, string>, name: string): string | undefined {
  const value = field(fields, name)
  return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : undefined
}

/** The first ATX heading's text: what a note someone typed is called, when it is called anything. */
const HEADING = /^#{1,6}[ \t]+(\S.*?)[ \t]*$/m

/**
 * What the card is headed with. A `title` when the file sets one, else the note's own first
 * heading, else the filename - which is always something, so a card is never nameless.
 */
function title(fields: Map<string, string>, body: string, slug: string): string {
  return field(fields, 'title') ?? HEADING.exec(body)?.[1] ?? slug
}

function blockedBy(raw: string | undefined, slug: string): string[] {
  const value = raw?.trim()
  if (!value) return []
  const blockers: string[] = []
  for (const entry of value.split(',')) {
    const blocker = entry.trim()
    // An empty entry is a stray separator rather than a reference, and a ticket cannot wait on
    // itself; neither is worth a chip, and neither is worth refusing the file over.
    if (!blocker || blocker === slug || blockers.includes(blocker)) continue
    blockers.push(blocker)
  }
  return blockers
}

/**
 * The ticket a file says it is, always: there is no reading that fails. `slug` is the filename
 * without `.md`, and deciding whether that filename is usable as an id belongs to whoever has the
 * folder - here it is only the last fallback for a title.
 */
export function readTicket(markdown: string, slug: string): Ticket {
  const parsed = lenientFrontmatter(markdown)
  const created = date(parsed.fields, 'created')
  const updated = date(parsed.fields, 'updated')
  return {
    slug,
    title: title(parsed.fields, parsed.body, slug),
    status: field(parsed.fields, 'status') ?? TICKET_STATUS.open,
    // Absent rather than undefined: these cross IPC, and a key that is there but empty invites a
    // reader to render it.
    ...(created ? { created } : {}),
    ...(updated ? { updated } : {}),
    blockedBy: blockedBy(parsed.fields.get('blocked_by'), slug),
    body: parsed.body,
    markdown
  }
}

/**
 * A status is one lowercase kebab-case word - the same shape as a slug, because both end up as
 * something a person types and a column is named after. Here rather than in the board or the
 * library so the file convention, the skill and every writer agree on one answer.
 */
export function isTicketStatus(value: string): boolean {
  return isTicketSlug(value)
}

/**
 * Whether `value` is usable as a project's `ticketsDirectory`. Tickets live *inside* the checkout,
 * so an absolute path or one that climbs out of it is refused: a hand-edited snapshot must not be
 * able to point Toucan's ticket reads and writes at an arbitrary folder.
 */
export function isTicketsDirectory(value: string): boolean {
  const trimmed = value.trim()
  if (!trimmed) return false
  const segments = trimmed.split(/[\\/]+/)
  if (segments.some((segment) => segment === '..')) return false
  return !isAbsolutePath(trimmed)
}

/**
 * The folder a project keeps tickets in, relative to its checkout: its own if it named a usable
 * one, and the default otherwise - including when it named one that leaves the checkout, which is
 * ignored rather than obeyed. The one answer to that question, so main's `ticketsDirectoryFor`
 * and the renderer's `ticketsRootFor` cannot drift apart.
 */
export function ticketsDirectoryOrDefault(configured?: string): string {
  return configured && isTicketsDirectory(configured) ? configured.trim() : DEFAULT_TICKETS_DIRECTORY
}

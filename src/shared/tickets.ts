import { parseFrontmatter } from './frontmatter'

/**
 * A ticket is a Markdown file in a project's tickets folder, and the file is the truth: Toucan
 * renders and mutates those files but never keeps a second copy of ticket state. This module is
 * the only place that decides what a conforming file looks like, so the board, the agent-facing
 * `tickets` skill and any future source all agree. Pure: no filesystem, no Node.
 */

/** The statuses Toucan ships columns for. A project may invent more; see `Ticket.status`. */
export type TicketStatus = 'open' | 'in-progress' | 'blocked' | 'done'

/** Board order, left to right. `done` last because the Done column is collapsed by default. */
export const DEFAULT_TICKET_STATUSES: readonly TicketStatus[] = ['open', 'in-progress', 'blocked', 'done']

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
  created: string
  updated: string
  /** Slugs of tickets in the same folder, deduplicated, in first-mention order. */
  blockedBy: string[]
  /** Everything after the frontmatter, verbatim. */
  body: string
  markdown: string
}

/** Why one file in the tickets folder is not a ticket. Listed on the board, never dropped. */
export interface TicketDiagnostic {
  path: string
  code: string
  message: string
}

/** The filename minus `.md`, and so also how `blocked_by` names a ticket. */
export function isTicketSlug(value: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)
}

function required(fields: Map<string, string>, name: string): string {
  const value = fields.get(name)?.trim()
  if (!value) throw new Error(`${name} is required.`)
  return value
}

function date(fields: Map<string, string>, name: string): string {
  const value = required(fields, name)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`${name} must use YYYY-MM-DD.`)
  return value
}

function blockedBy(raw: string | undefined, slug: string): string[] {
  const value = raw?.trim()
  if (!value) return []
  const blockers: string[] = []
  for (const entry of value.split(',')) {
    const blocker = entry.trim()
    if (!isTicketSlug(blocker)) throw new Error('blocked_by must be a comma separated list of ticket slugs.')
    if (blocker === slug) throw new Error('blocked_by must not reference the ticket itself.')
    if (!blockers.includes(blocker)) blockers.push(blocker)
  }
  return blockers
}

/**
 * Throws with a human-readable reason when `markdown` is not a conforming ticket; callers turn
 * that into a `TicketDiagnostic` so a broken file stays visible instead of vanishing.
 */
export function parseTicket(markdown: string, slug: string): Ticket {
  if (!isTicketSlug(slug)) throw new Error('Filename must be a lowercase kebab-case slug.')
  const parsed = parseFrontmatter(markdown, 'Ticket')
  if (!parsed.ok) throw new Error(parsed.message)
  return {
    slug,
    title: required(parsed.fields, 'title'),
    status: required(parsed.fields, 'status'),
    created: date(parsed.fields, 'created'),
    updated: date(parsed.fields, 'updated'),
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
  // Absolute in either flavour: a leading separator, or a Windows drive or UNC prefix.
  return !/^([a-zA-Z]:|[\\/])/.test(trimmed)
}

import { DEFAULT_TICKET_STATUSES, TICKET_STATUS } from '../../shared/tickets'
import type { TicketCard, TicketSource, TicketSourceListResult } from '../../shared/ticket-source'

/**
 * Everything the ticket board decides before anything is drawn: which columns exist, which cards
 * sit in each, which of them a collapsed Done column withholds, and what a blocker chip means.
 * Pure, so the board's arithmetic can be reasoned about without a DOM - and so the answers cannot
 * quietly differ between the panel and a test.
 *
 * It is written against *cards from several sources*, not against ticket files: adding GitHub
 * later must not touch this module.
 */

/** A Done card older than this is folded away, because a closed ticket stops being news. */
export const DONE_COLUMN_RECENT_DAYS = 30

const DAY_MS = 86_400_000

export type TicketBlockerState = 'done' | 'pending' | 'missing'

export interface TicketBlocker {
  id: string
  state: TicketBlockerState
}

export interface TicketBoardColumn {
  status: string
  label: string
  cards: TicketCard[]
  /** Cards the Done cutoff is currently withholding. Always zero in every other column. */
  hidden: number
}

export interface TicketBoardInput {
  /** One listing per source that has answered, in the order the sources are configured. */
  listings: readonly TicketSourceListResult[]
  /** Today as `YYYY-MM-DD`: tickets record calendar days, so the cutoff counts days, not hours. */
  today: string
  showAllDone: boolean
}

function calendarDaysBetween(from: string, to: string): number | null {
  const start = Date.parse(`${from}T00:00:00Z`)
  const end = Date.parse(`${to}T00:00:00Z`)
  if (Number.isNaN(start) || Number.isNaN(end)) return null
  return Math.round((end - start) / DAY_MS)
}

/** `in-progress` reads as "In progress"; an invented status is titled from its own words. */
export function ticketStatusLabel(status: string): string {
  const words = status.split('-').filter(Boolean).join(' ')
  return words ? words.charAt(0).toLocaleUpperCase() + words.slice(1) : status
}

/**
 * A card's `updated` relative to `today`, both calendar dates. Beyond a week the exact date says
 * more than a widening count of days.
 */
export function describeTicketDate(updated: string, today: string): string {
  if (updated === today) return 'today'
  const elapsed = calendarDaysBetween(updated, today)
  if (elapsed === null) return updated
  if (elapsed === 1) return 'yesterday'
  if (elapsed > 1 && elapsed < 7) return `${elapsed} days ago`
  return updated
}

/**
 * Blockers named by `card`, resolved against the cards of its own source only: `blocked_by` names
 * tickets in the same folder, and two sources may legitimately use the same id for different work.
 * A blocker nobody lists is `missing` rather than dropped, so a typo stays visible on the board.
 */
export function ticketBlockers(card: TicketCard, cards: readonly TicketCard[]): TicketBlocker[] {
  if (!card.blockedBy?.length) return []
  const siblings = new Map(cards.filter((entry) => entry.sourceId === card.sourceId).map((entry) => [entry.id, entry]))
  return card.blockedBy.map((id) => {
    const blocker = siblings.get(id)
    return { id, state: blocker ? (blocker.status === TICKET_STATUS.done ? 'done' : 'pending') : 'missing' }
  })
}

/** The source a card came from, or `undefined` for a card whose source is no longer configured. */
export function ticketSourceFor(card: TicketCard, sources: readonly TicketSource[]): TicketSource | undefined {
  return sources.find((source) => source.id === card.sourceId)
}

/** A card can only change column when the source that owns it can write the change back. */
export function ticketDropAllowed(card: TicketCard, sources: readonly TicketSource[]): boolean {
  return !!ticketSourceFor(card, sources)?.setStatus
}

/** A card can only be deleted when its source's records are Toucan's to destroy; issues are not. */
export function ticketRemoveAllowed(card: TicketCard, sources: readonly TicketSource[]): boolean {
  return !!ticketSourceFor(card, sources)?.remove
}

/**
 * Newest first, then alphabetically, then by source: a board that reorders itself between two
 * identical listings is a board nobody can point at.
 */
function byRecencyThenTitle(left: TicketCard, right: TicketCard): number {
  return (
    right.updated.localeCompare(left.updated) ||
    left.title.localeCompare(right.title) ||
    left.sourceId.localeCompare(right.sourceId) ||
    left.id.localeCompare(right.id)
  )
}

/**
 * The four shipped statuses always have a column, whether or not a ticket sits in one - an empty
 * column is where a card gets dropped - followed by any status a project invented, in the order
 * the cards were listed: the files source lists its folder alphabetically, so that order is as
 * stable as the folder is.
 */
function columnStatuses(cards: readonly TicketCard[]): string[] {
  const defaults = DEFAULT_TICKET_STATUSES as readonly string[]
  const extra: string[] = []
  for (const card of cards) {
    if (!defaults.includes(card.status) && !extra.includes(card.status)) extra.push(card.status)
  }
  return [...defaults, ...extra]
}

/**
 * Closed, and closed long enough ago that the Done column has folded it away. One predicate for
 * the cutoff, so what the bulk delete offers to remove is exactly what the column stopped showing:
 * two spellings of "older than 30 days" would eventually disagree about a card on the boundary.
 */
function isStaleDone(card: TicketCard, today: string): boolean {
  if (card.status !== TICKET_STATUS.done) return false
  const elapsed = calendarDaysBetween(card.updated, today)
  // An unreadable date is never stale: a file Toucan cannot date is not one it may offer to delete.
  return elapsed !== null && elapsed > DONE_COLUMN_RECENT_DAYS
}

/** The Done cards the cutoff has folded away, newest first, for the Done column's bulk delete. */
export function staleDoneCards(cards: readonly TicketCard[], today: string): TicketCard[] {
  return cards.filter((card) => isStaleDone(card, today)).sort(byRecencyThenTitle)
}

export function ticketBoardColumns(input: TicketBoardInput): TicketBoardColumn[] {
  const cards = input.listings.flatMap((listing) => listing.cards)
  return columnStatuses(cards).map((status) => {
    const inColumn = cards.filter((card) => card.status === status).sort(byRecencyThenTitle)
    if (status !== TICKET_STATUS.done || input.showAllDone)
      return { status, label: ticketStatusLabel(status), cards: inColumn, hidden: 0 }
    const recent = inColumn.filter((card) => !isStaleDone(card, input.today))
    return { status, label: ticketStatusLabel(status), cards: recent, hidden: inColumn.length - recent.length }
  })
}

/**
 * The status one column to the side, for moving a card without a pointer. Returns `undefined` at
 * either end of the board rather than wrapping: a keyboard move should stop where a drag would.
 */
export function ticketStatusBeside(
  columns: readonly TicketBoardColumn[],
  status: string,
  delta: number
): string | undefined {
  const index = columns.findIndex((column) => column.status === status)
  return index < 0 ? undefined : columns[index + delta]?.status
}

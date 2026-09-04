import type { Ticket, TicketDiagnostic } from './tickets'

/**
 * What the ticket board renders. A board never renders tickets: it renders *cards*, so a Markdown
 * file in the checkout, a GitHub issue and whatever tracker comes next reach the same columns
 * through one interface. Only the files source ships today; everything above this seam - the
 * panel, the hook, the column maths - is already written against several.
 *
 * Pure: a source's implementation lives wherever its data does (preload bridge, HTTP client), but
 * the contract itself is runtime-neutral so main, preload and renderer can all name it.
 */

/** Source-neutral: the fields every tracker can answer, and nothing a single tracker invented. */
export interface TicketCard {
  /** Which `TicketSource` produced this card; with `id` it is the card's identity on the board. */
  sourceId: string
  /** Unique within the source. For the files source it is the ticket's slug. */
  id: string
  title: string
  /** One of `DEFAULT_TICKET_STATUSES`, or a status the project invented; see `shared/tickets.ts`. */
  status: string
  /** `YYYY-MM-DD`. Card ordering and the Done column's cutoff both read this. */
  updated: string
  /** Ids of blocking cards *in the same source*; cross-source links are prose in the body. */
  blockedBy?: string[]
  /** Markdown, rendered when a card is expanded. Absent when the source cannot supply one. */
  body?: string
  /** Where the card lives outside Toucan, for a source that has such a place. */
  url?: string
}

export interface TicketSourceListResult {
  cards: TicketCard[]
  /** Never dropped silently: a file or record the source could not read is shown on the board. */
  diagnostics: TicketDiagnostic[]
}

export type TicketMutationResult = { ok: true; card: TicketCard } | { ok: false; code: string; message: string }

export interface TicketSource {
  id: string
  label: string
  list(projectPath: string): Promise<TicketSourceListResult>
  /**
   * Absent when the source cannot be written to, which is exactly what makes its columns refuse a
   * drop. A source that can write is expected to have persisted the change before it resolves.
   */
  setStatus?(projectPath: string, cardId: string, status: string): Promise<TicketMutationResult>
  /** Reveals the card where it actually lives - a file in the shell, an issue in the browser. */
  openExternal?(projectPath: string, cardId: string): void
  /**
   * Absent when the source cannot say when it changed; the board then only re-lists when asked.
   * A source that polls does so behind this, so the board never learns how any source finds out.
   */
  onChange?(callback: (projectPath: string) => void): () => void
}

/** The board's identity for a card: unique across sources that may both use the slug `board`. */
export function ticketCardKey(card: Pick<TicketCard, 'sourceId' | 'id'>): string {
  return `${card.sourceId}:${card.id}`
}

/** The renderer-facing half of the files source, exposed by the preload bridge as `ticketsApi`. */
export interface TicketFilesApi {
  list(projectPath: string): Promise<TicketSourceListResult>
  setStatus(projectPath: string, slug: string, status: string): Promise<TicketMutationResult>
  /** Shows the ticket file in the OS file manager. */
  revealInFolder(projectPath: string, slug: string): void
  /** Fires with the project path whose tickets folder changed on disk. */
  onChange(callback: (projectPath: string) => void): () => void
}

/** The id of the always-on source backed by the project's own Markdown files. */
export const TICKET_FILES_SOURCE_ID = 'files'

/** The one projection of a ticket file onto the board's source-neutral card. */
export function ticketCard(ticket: Ticket): TicketCard {
  return {
    sourceId: TICKET_FILES_SOURCE_ID,
    id: ticket.slug,
    title: ticket.title,
    status: ticket.status,
    updated: ticket.updated,
    ...(ticket.blockedBy.length > 0 ? { blockedBy: ticket.blockedBy } : {}),
    body: ticket.body
  }
}

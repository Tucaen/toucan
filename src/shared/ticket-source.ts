import type { Ticket, TicketDiagnostic } from './tickets'

/**
 * What the ticket board renders. A board never renders tickets: it renders *cards*, so a Markdown
 * file in the checkout, a GitHub issue and whatever tracker comes next reach the same columns
 * through one interface. The files in a checkout and a project’s GitHub issues both arrive this
 * way, and everything above the seam - the panel, the hook, the column maths - knows only cards.
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
  /**
   * `YYYY-MM-DD`, when the source knows it. Absent for a record that carries no date - a card
   * then shows none, because a shown date a user cannot find in the file is worse than no date -
   * and `orderedAt` is what places it. The Done column's cutoff reads this and only this: a card
   * Toucan cannot date is never old enough to fold away or offer to delete.
   */
  updated?: string
  /**
   * Epoch milliseconds, for ordering a card whose `updated` is absent - the file's own mtime for
   * the files source. Never displayed and never turned back into a date: it says when something
   * last changed on disk, which is not a claim about the work.
   */
  orderedAt?: number
  /** Ids of blocking cards *in the same source*; cross-source links are prose in the body. */
  blockedBy?: string[]
  /** Markdown, rendered when a card is expanded. Absent when the source cannot supply one. */
  body?: string
  /** Where the card lives outside Toucan, for a source that has such a place. */
  url?: string
}

/**
 * Whether a source can answer for this project at all. A source that never says otherwise is
 * always usable; one that answers this is *optional*, and the board offers it as a per-project
 * toggle rather than listing it unasked. `reason` is shown to the user, so it says what to do.
 */
export interface TicketSourceUnavailable {
  available: false
  reason: string
}

export type TicketSourceAvailability =
  /** `detail` identifies what was found, e.g. the GitHub repository the remote points at. */
  { available: true; detail?: string } | TicketSourceUnavailable

export interface TicketSourceListResult {
  cards: TicketCard[]
  /** Never dropped silently: a file or record the source could not read is shown on the board. */
  diagnostics: TicketDiagnostic[]
}

/** The listing of a project with nothing to list, for every caller that has to say so. */
export const EMPTY_TICKET_LISTING: TicketSourceListResult = { cards: [], diagnostics: [] }

export type TicketMutationResult = { ok: true; card: TicketCard } | { ok: false; code: string; message: string }

/** No card comes back: what succeeded is that the card is gone. */
export type TicketRemovalResult = { ok: true } | { ok: false; code: string; message: string }

export interface TicketSource {
  id: string
  label: string
  list(projectPath: string): Promise<TicketSourceListResult>
  /**
   * Absent for a source that is always usable - the files in a checkout always are. Present for
   * one that depends on the machine or the project, and answering it is what makes the source
   * optional: the board probes it, offers a toggle, and lists the source only once switched on.
   */
  availability?(projectPath: string): Promise<TicketSourceAvailability>
  /**
   * Absent when the source cannot be written to, which is exactly what makes its columns refuse a
   * drop. A source that can write is expected to have persisted the change before it resolves.
   */
  setStatus?(projectPath: string, cardId: string, status: string): Promise<TicketMutationResult>
  /**
   * Absent when the source's records are not Toucan's to destroy - a GitHub issue is closed, never
   * deleted - which is exactly what hides Delete on its cards. A folder of hundreds of closed
   * tickets is what this exists for: list and agent read cost should stay proportional to live work.
   */
  remove?(projectPath: string, cardId: string): Promise<TicketRemovalResult>
  /**
   * What deleting from this source costs, in the source's own words, for the confirmation to show.
   * The board never learns *why* - whether a checkout's history would keep the file is the files
   * source's business - so a source that cannot say resolves to undefined and the board says only
   * that the card is deleted.
   */
  removalNote?(projectPath: string): Promise<string | undefined>
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
  /** Deletes the ticket file. Nothing is archived or trashed; a git checkout's history is the backup. */
  remove(projectPath: string, slug: string): Promise<TicketRemovalResult>
  /**
   * Whether the project is a git checkout, which is the whole difference between a deletion that
   * history keeps and one that is final - and so the only thing the delete confirmation needs.
   */
  isGitRepository(projectPath: string): Promise<boolean>
  /** Shows the ticket file in the OS file manager. */
  revealInFolder(projectPath: string, slug: string): void
  /** Fires with the project path whose tickets folder changed on disk. */
  onChange(callback: (projectPath: string) => void): () => void
}

/**
 * A listing, or the reason there is nothing to list. One type rather than two calls: probing and
 * listing can disagree - `gh` was there a second ago and is unauthenticated now - and a board that
 * asked for issues must be told that, not handed an empty column that looks like an empty backlog.
 */
export type TicketGithubListResult = (TicketSourceListResult & { available: true }) | TicketSourceUnavailable

/** The renderer-facing half of the GitHub source, exposed by the preload bridge as `githubIssuesApi`. */
export interface TicketGithubApi {
  availability(projectPath: string): Promise<TicketSourceAvailability>
  list(projectPath: string): Promise<TicketGithubListResult>
}

/** The id of the always-on source backed by the project's own Markdown files. */
export const TICKET_FILES_SOURCE_ID = 'files'

/**
 * The one projection of a ticket file onto the board's source-neutral card. `orderedAt` is the
 * file's mtime, and it is only ever *read* for a ticket that wrote no `updated` - so a caller
 * that has it passes it without having to know that rule, and the one caller that has just
 * stamped `updated` itself (a status write) has nothing to pass.
 */
export function ticketCard(ticket: Ticket, orderedAt?: number): TicketCard {
  return {
    sourceId: TICKET_FILES_SOURCE_ID,
    id: ticket.slug,
    title: ticket.title,
    status: ticket.status,
    ...(ticket.updated ? { updated: ticket.updated } : {}),
    ...(orderedAt === undefined ? {} : { orderedAt }),
    ...(ticket.blockedBy.length > 0 ? { blockedBy: ticket.blockedBy } : {}),
    body: ticket.body
  }
}

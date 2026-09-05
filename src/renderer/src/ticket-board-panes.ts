import { ticketCardKey, type TicketCard } from '../../shared/ticket-source'
import type { TicketBoardColumn } from './ticket-board'

/**
 * Everything the three-pane board decides before anything is drawn: which state row is selected,
 * which ticket the detail is showing, how much of the panel the detail may take, and which pane a
 * Left/Right press reaches. Pure, so the board's arithmetic can be reasoned about without a DOM.
 *
 * Kept apart from `ticket-board.ts` (which columns exist and what is in them) and from
 * `ticket-board-layout.ts` (where the whole panel sits in the workspace): this module is only
 * about the panel's inside, and the other two must stay usable without it.
 */

/** The states pane is a list of short labels; it never earns more than this (`.ticket-state-list`). */
export const TICKET_STATE_PANE_WIDTH = 138
/** Below this the ticket cards are narrower than the meta line they carry. */
export const TICKET_LIST_MIN_WIDTH = 240
/** The reading surface the whole redesign exists for: less than this and a body wraps to shreds. */
export const TICKET_DETAIL_MIN_WIDTH = 320
export const TICKET_DETAIL_DEFAULT_WIDTH = 420
/**
 * The horizontal padding and the two gaps `.ticket-board-panes` spends on itself. Counted here
 * because a threshold that forgets the chrome promises a third pane the panel cannot actually
 * seat, and then lets the detail take the width out of the list.
 */
export const TICKET_PANES_CHROME_WIDTH = 54

/** Every pane's floor plus the chrome between them: the narrowest panel that can seat all three. */
const THREE_PANE_WIDTH =
  TICKET_STATE_PANE_WIDTH + TICKET_LIST_MIN_WIDTH + TICKET_DETAIL_MIN_WIDTH + TICKET_PANES_CHROME_WIDTH

/** Three panes side by side, or a board narrow enough that the detail replaces the list. */
export type TicketPaneMode = 'three' | 'two'

export type TicketPane = 'states' | 'list' | 'detail'

/** What the board is currently pointed at. The ticket is keyed, so it survives a status move. */
export interface TicketPaneSelection {
  status: string | null
  cardKey: string | null
}

export interface TicketPaneInput {
  columns: readonly TicketBoardColumn[]
  /** Every listed card, across sources - the detail's ticket may have left the selected state. */
  cards: readonly TicketCard[]
  selection: TicketPaneSelection
}

/**
 * The selection a fresh listing leaves behind.
 *
 * The rule: **the ticket wins**. A ticket that is still listed keeps the detail open and drags the
 * state selection to wherever it now lives, which is what makes "drop it on Done and keep reading
 * it" work. A ticket that is gone clears the detail rather than leaving a ghost open, and the state
 * then falls back to whatever is still a state: the chosen one, else the first with tickets, else
 * the first, so an empty board still shows a drop target.
 *
 * Choosing a state row is therefore always paired with clearing the ticket by the caller; without
 * that, this function would keep pulling the selection back to the open ticket's own state.
 */
export function resolveTicketPanes(input: TicketPaneInput): TicketPaneSelection {
  const { columns, cards, selection } = input
  const open = selection.cardKey ? cards.find((card) => ticketCardKey(card) === selection.cardKey) : undefined
  if (open) return { status: open.status, cardKey: selection.cardKey }
  const chosen = columns.find((column) => column.status === selection.status)
  const fallback = columns.find((column) => column.cards.length + column.hidden > 0) ?? columns[0]
  return { status: (chosen ?? fallback)?.status ?? null, cardKey: null }
}

/** Whether the panel can hold states, list and detail at once, or must swap the last two. */
export function ticketPaneMode(panelWidth: number): TicketPaneMode {
  return Number.isFinite(panelWidth) && panelWidth >= THREE_PANE_WIDTH ? 'three' : 'two'
}

/**
 * Folds any candidate detail width - a stored one from a wider panel, or none at all - into the
 * panel. The ceiling is what is left once the states pane, the chrome and the list's own floor
 * have been taken out, so widening the detail can never push the list below what it needs.
 */
export function clampTicketDetailWidth(width: number | undefined, panelWidth: number): number {
  const room = panelWidth - TICKET_STATE_PANE_WIDTH - TICKET_LIST_MIN_WIDTH - TICKET_PANES_CHROME_WIDTH
  const max = Math.max(TICKET_DETAIL_MIN_WIDTH, room)
  const candidate = width !== undefined && Number.isFinite(width) && width > 0 ? Math.round(width) : undefined
  return Math.min(max, Math.max(TICKET_DETAIL_MIN_WIDTH, candidate ?? TICKET_DETAIL_DEFAULT_WIDTH))
}

/** The detail is the right-most pane, so a divider drag's width is whatever remains to that edge. */
export function ticketDetailWidthFromPointer(pointerX: number, panesRight: number, panelWidth: number): number {
  return clampTicketDetailWidth(panesRight - pointerX, panelWidth)
}

/**
 * What an arrow key means, in one place. Four keydown handlers on the board read arrows - the
 * state list, the ticket list, a card's grip and the two separators - and each one only cares
 * about one axis, so each reads the axis it owns and ignores the rest.
 */
export function ticketArrowStep(key: string): { axis: 'horizontal' | 'vertical'; delta: number } | undefined {
  if (key === 'ArrowLeft') return { axis: 'horizontal', delta: -1 }
  if (key === 'ArrowRight') return { axis: 'horizontal', delta: 1 }
  if (key === 'ArrowUp') return { axis: 'vertical', delta: -1 }
  if (key === 'ArrowDown') return { axis: 'vertical', delta: 1 }
  return undefined
}

/**
 * The panes actually on screen, left to right. The detail only exists once a ticket is open, and a
 * narrow board spends its one remaining pane on the detail instead of showing two half-panes.
 */
export function visibleTicketPanes(mode: TicketPaneMode, hasTicket: boolean): TicketPane[] {
  if (!hasTicket) return ['states', 'list']
  return mode === 'three' ? ['states', 'list', 'detail'] : ['states', 'detail']
}

/**
 * The pane one step to the side. Returns `undefined` at either end rather than wrapping: focus
 * that reappears on the far side of the board is focus nobody can follow.
 */
export function ticketPaneBeside(
  visible: readonly TicketPane[],
  pane: TicketPane,
  delta: number
): TicketPane | undefined {
  const index = visible.indexOf(pane)
  return index < 0 ? undefined : visible[index + delta]
}

/** The row one step up or down inside a list, clamped at both ends for the same reason. */
export function ticketIndexBeside(length: number, index: number, delta: number): number {
  if (length === 0) return -1
  return Math.min(length - 1, Math.max(0, index + delta))
}

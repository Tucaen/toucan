/**
 * The docked ticket board's width and shortcut decisions, kept out of `App.tsx` and the panel view
 * so they can be reasoned about (and tested) without a DOM. The board *consumes* workspace width
 * rather than overlaying the canvas, exactly as the brain-dump panel does, so these bounds are the
 * only thing standing between a restored width and a canvas squeezed out of existence.
 *
 * Deliberately not shared with `brain-dump-panel-layout.ts`: the two panels agree on the docking
 * mechanics and on nothing else. A board of columns needs a different floor from a list-and-reader
 * pane, and folding both into one module would make every future change to either a negotiation.
 */

/** Below this a board of columns is narrower than the cards it holds. */
export const TICKET_BOARD_MIN_WIDTH = 480
export const TICKET_BOARD_DEFAULT_WIDTH = 880
export const TICKET_BOARD_MAX_WIDTH = 1240
/** The board never takes more than this share of the workspace, however wide the window is. */
export const TICKET_BOARD_MAX_WORKSPACE_SHARE = 0.7

export interface TicketBoardBounds {
  min: number
  max: number
}

/**
 * The widths a board may occupy in a workspace of `workspaceWidth`. A window too small to honour
 * both bounds still yields `min`: a board briefly wider than its share beats one collapsed to an
 * unusable sliver.
 */
export function ticketBoardBounds(workspaceWidth: number): TicketBoardBounds {
  const usable = Number.isFinite(workspaceWidth) && workspaceWidth > 0 ? workspaceWidth : null
  if (usable === null) return { min: TICKET_BOARD_MIN_WIDTH, max: TICKET_BOARD_MAX_WIDTH }
  const share = Math.floor(usable * TICKET_BOARD_MAX_WORKSPACE_SHARE)
  return {
    min: TICKET_BOARD_MIN_WIDTH,
    max: Math.max(TICKET_BOARD_MIN_WIDTH, Math.min(TICKET_BOARD_MAX_WIDTH, share))
  }
}

/**
 * Folds any candidate width - a persisted one from an older, wider window included - into the
 * bounds of the current workspace. Anything unusable falls back to the comfortable default.
 */
export function clampTicketBoardWidth(width: number, workspaceWidth: number): number {
  const { min, max } = ticketBoardBounds(workspaceWidth)
  const candidate = Number.isFinite(width) && width > 0 ? Math.round(width) : TICKET_BOARD_DEFAULT_WIDTH
  return Math.min(max, Math.max(min, candidate))
}

/** The board is docked right, so a left-edge drag's width is whatever remains to that edge. */
export function ticketBoardWidthFromPointer(pointerX: number, workspaceRight: number, workspaceWidth: number): number {
  return clampTicketBoardWidth(workspaceRight - pointerX, workspaceWidth)
}

/** The subset of `KeyboardEvent` the board's shortcut reads, so callers can test without a DOM. */
export interface TicketBoardShortcutKey {
  key: string
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
  metaKey: boolean
}

export type TicketBoardKeyAction = 'toggle-panel' | 'none'

/**
 * Ctrl+Shift+K toggles the board from anywhere, including from inside a text field: unlike the
 * brain-dump panel's Ctrl+K, it moves no caret and steals no typing, so there is nothing for an
 * editing context to protect.
 */
export function ticketBoardKeyAction(event: TicketBoardShortcutKey): TicketBoardKeyAction {
  if (event.altKey || event.metaKey || !event.ctrlKey || !event.shiftKey) return 'none'
  return event.key.toLocaleLowerCase() === 'k' ? 'toggle-panel' : 'none'
}

/**
 * Every width and mode decision the docked brain-dump panel makes, kept out of `App.tsx` and the
 * panel view so the layout can be reasoned about (and tested) without a DOM. The panel *consumes*
 * workspace width rather than overlaying the canvas, so these bounds are the only thing standing
 * between a restored width and a canvas squeezed out of existence.
 */

/**
 * Below this the list and reader can no longer both stay readable.
 * @internal exported for tests
 */
export const BRAIN_DUMP_PANEL_MIN_WIDTH = 420
export const BRAIN_DUMP_PANEL_DEFAULT_WIDTH = 760
/** @internal exported for tests */
export const BRAIN_DUMP_PANEL_MAX_WIDTH = 920
/** The panel never takes more than this share of the workspace, however wide the window is. */
export const BRAIN_DUMP_PANEL_MAX_WORKSPACE_SHARE = 0.7
/** A panel narrower than this shows list *or* reader instead of squeezing both columns. */
export const BRAIN_DUMP_PANEL_WIDE_MIN_WIDTH = 640

export type BrainDumpPanelMode = 'wide' | 'narrow'

export interface BrainDumpPanelBounds {
  min: number
  max: number
}

function usableWorkspaceWidth(workspaceWidth: number): number | null {
  return Number.isFinite(workspaceWidth) && workspaceWidth > 0 ? workspaceWidth : null
}

/**
 * The widths a panel may occupy in a workspace of `workspaceWidth`. A window too small to honour
 * both bounds still yields `min`: a panel that is briefly wider than its share beats one collapsed
 * to an unusable sliver.
 */
export function brainDumpPanelBounds(workspaceWidth: number): BrainDumpPanelBounds {
  const workspace = usableWorkspaceWidth(workspaceWidth)
  if (workspace === null) return { min: BRAIN_DUMP_PANEL_MIN_WIDTH, max: BRAIN_DUMP_PANEL_MAX_WIDTH }
  const share = Math.floor(workspace * BRAIN_DUMP_PANEL_MAX_WORKSPACE_SHARE)
  return {
    min: BRAIN_DUMP_PANEL_MIN_WIDTH,
    max: Math.max(BRAIN_DUMP_PANEL_MIN_WIDTH, Math.min(BRAIN_DUMP_PANEL_MAX_WIDTH, share))
  }
}

/**
 * Folds any candidate width - a persisted one from an older, wider window included - into the
 * bounds of the current workspace. Anything unusable falls back to the comfortable default.
 */
export function clampBrainDumpPanelWidth(width: number, workspaceWidth: number): number {
  const { min, max } = brainDumpPanelBounds(workspaceWidth)
  const candidate = Number.isFinite(width) && width > 0 ? Math.round(width) : BRAIN_DUMP_PANEL_DEFAULT_WIDTH
  return Math.min(max, Math.max(min, candidate))
}

export function brainDumpPanelMode(width: number): BrainDumpPanelMode {
  return width >= BRAIN_DUMP_PANEL_WIDE_MIN_WIDTH ? 'wide' : 'narrow'
}

/**
 * The width a left-edge drag implies. The panel is docked right, so its width is whatever remains
 * between the pointer and the workspace's right edge.
 */
export function brainDumpPanelWidthFromPointer(
  pointerX: number,
  workspaceRight: number,
  workspaceWidth: number
): number {
  return clampBrainDumpPanelWidth(workspaceRight - pointerX, workspaceWidth)
}

/** The subset of `KeyboardEvent` the panel's shortcuts read, so callers can test without a DOM. */
export interface BrainDumpShortcutKey {
  key: string
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
  metaKey: boolean
}

export type BrainDumpKeyAction = 'toggle-panel' | 'focus-search' | 'none'

export interface BrainDumpShortcutContext {
  panelOpen: boolean
  /** True when the key landed in an input, textarea, or editable region. */
  editingText: boolean
}

/**
 * Ctrl+Shift+B toggles the panel from anywhere; Ctrl+K reaches the search field only while the
 * panel is open and the user is not already typing somewhere, so it never steals a text caret.
 */
export function brainDumpPanelKeyAction(
  event: BrainDumpShortcutKey,
  context: BrainDumpShortcutContext
): BrainDumpKeyAction {
  if (event.altKey || event.metaKey) return 'none'
  const key = event.key.toLocaleLowerCase()
  if (key === 'b' && event.ctrlKey && event.shiftKey) return 'toggle-panel'
  if (key === 'k' && event.ctrlKey && !event.shiftKey && context.panelOpen && !context.editingText)
    return 'focus-search'
  return 'none'
}

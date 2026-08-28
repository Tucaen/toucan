export interface NodePickerMenuRect {
  top: number
  left: number
  right: number
  bottom: number
}

export interface NodePickerMenuSize {
  width: number
  height: number
}

export interface NodePickerMenuPosition {
  top: number
  left: number
}

export interface NodePickerMenuOptions {
  /** Space between the trigger's edge and the menu. */
  gap?: number
  /** Which of the trigger's edges the menu lines up with: its right edge (default) or its left. */
  align?: 'start' | 'end'
  /** Which side to try first; the menu still flips when that side has no room. */
  prefer?: 'below' | 'above'
}

const VIEWPORT_MARGIN = 8

/**
 * Positions a portal-rendered picker menu against its trigger button using
 * viewport coordinates, clamped so no part of the menu ever falls outside the
 * viewport - regardless of how narrow or how close to an edge the trigger is.
 * Opens below the trigger by default, flipping to the other side when there
 * isn't enough room on the preferred one.
 */
export function computeNodePickerMenuPosition(
  trigger: NodePickerMenuRect,
  menu: NodePickerMenuSize,
  viewport: NodePickerMenuSize,
  options: NodePickerMenuOptions = {}
): NodePickerMenuPosition {
  const { gap = 7, align = 'end', prefer = 'below' } = options

  const maxLeft = Math.max(VIEWPORT_MARGIN, viewport.width - menu.width - VIEWPORT_MARGIN)
  const preferredLeft = align === 'start' ? trigger.left : trigger.right - menu.width
  const left = Math.min(Math.max(preferredLeft, VIEWPORT_MARGIN), maxLeft)

  const below = trigger.bottom + gap
  const above = trigger.top - gap - menu.height
  const fitsBelow = below + menu.height <= viewport.height - VIEWPORT_MARGIN
  const fitsAbove = above >= VIEWPORT_MARGIN
  const opensBelow = prefer === 'below' ? fitsBelow || !fitsAbove : !fitsAbove && fitsBelow
  const clamp = (top: number): number => Math.max(
    VIEWPORT_MARGIN,
    Math.min(top, viewport.height - menu.height - VIEWPORT_MARGIN)
  )
  const top = opensBelow
    ? (fitsBelow ? below : clamp(below))
    : clamp(above)

  return { top, left }
}

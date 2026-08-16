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

const VIEWPORT_MARGIN = 8

/**
 * Positions a portal-rendered picker menu against its trigger button using
 * viewport coordinates, clamped so no part of the menu ever falls outside the
 * viewport - regardless of how narrow or how close to an edge the trigger is.
 * Opens below the trigger by default, flipping above it when there isn't
 * enough room underneath.
 */
export function computeNodePickerMenuPosition(
  trigger: NodePickerMenuRect,
  menu: NodePickerMenuSize,
  viewport: NodePickerMenuSize,
  gap = 7
): NodePickerMenuPosition {
  const maxLeft = Math.max(VIEWPORT_MARGIN, viewport.width - menu.width - VIEWPORT_MARGIN)
  const left = Math.min(Math.max(trigger.right - menu.width, VIEWPORT_MARGIN), maxLeft)

  const below = trigger.bottom + gap
  const fitsBelow = below + menu.height <= viewport.height - VIEWPORT_MARGIN
  const above = trigger.top - gap - menu.height
  const top = fitsBelow
    ? below
    : Math.max(VIEWPORT_MARGIN, Math.min(above, viewport.height - menu.height - VIEWPORT_MARGIN))

  return { top, left }
}

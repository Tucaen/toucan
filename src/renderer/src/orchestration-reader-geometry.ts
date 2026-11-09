/**
 * Where the floating questions reader sits and how big it is. Pure, so the window's bounds are one
 * rule: it never leaves the viewport, and its size stays between a readable minimum and a maximum.
 */
export interface ReaderRect {
  left: number
  top: number
  width: number
  height: number
}

export interface ReaderViewport {
  width: number
  height: number
}

/** The gap kept between the window and the viewport edge. */
export const READER_MARGIN = 8
export const READER_MIN = { width: 340, height: 280 } as const
export const READER_MAX = { width: 960, height: 1100 } as const

const DEFAULT_SIZE = { width: 520, height: 560 } as const
/** Below the app header, so a fresh window opens over the canvas rather than the title bar. */
const DEFAULT_TOP = 64

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max))
}

/** The limits for one axis; a viewport smaller than the minimum shrinks the minimum with it. */
function sizeLimits(minimum: number, maximum: number, available: number): { min: number; max: number } {
  const room = Math.max(0, available - 2 * READER_MARGIN)
  return { min: Math.min(minimum, room), max: Math.min(maximum, room) }
}

export function clampReaderRect(rect: ReaderRect, viewport: ReaderViewport): ReaderRect {
  const w = sizeLimits(READER_MIN.width, READER_MAX.width, viewport.width)
  const h = sizeLimits(READER_MIN.height, READER_MAX.height, viewport.height)
  const width = clamp(rect.width, w.min, w.max)
  const height = clamp(rect.height, h.min, h.max)
  return {
    width,
    height,
    left: clamp(rect.left, READER_MARGIN, viewport.width - width - READER_MARGIN),
    top: clamp(rect.top, READER_MARGIN, viewport.height - height - READER_MARGIN)
  }
}

/** A fresh window: right-aligned and tall, where the canvas stays visible to its left. */
export function defaultReaderRect(viewport: ReaderViewport): ReaderRect {
  return clampReaderRect(
    {
      ...DEFAULT_SIZE,
      left: viewport.width - DEFAULT_SIZE.width - 24,
      top: DEFAULT_TOP
    },
    viewport
  )
}

export function moveReaderRect(rect: ReaderRect, dx: number, dy: number, viewport: ReaderViewport): ReaderRect {
  return clampReaderRect({ ...rect, left: rect.left + dx, top: rect.top + dy }, viewport)
}

/** Drag of the bottom-right corner: the top-left corner stays, the size follows within the limits. */
export function resizeReaderRect(rect: ReaderRect, dx: number, dy: number, viewport: ReaderViewport): ReaderRect {
  const w = sizeLimits(READER_MIN.width, READER_MAX.width, viewport.width)
  const h = sizeLimits(READER_MIN.height, READER_MAX.height, viewport.height)
  return {
    ...rect,
    width: clamp(rect.width + dx, w.min, Math.min(w.max, viewport.width - rect.left - READER_MARGIN)),
    height: clamp(rect.height + dy, h.min, Math.min(h.max, viewport.height - rect.top - READER_MARGIN))
  }
}

const remembered = new Map<string, ReaderRect>()

/** Remembered for the app session, per orchestrator node. */
export function rememberReaderRect(nodeId: string, rect: ReaderRect): void {
  remembered.set(nodeId, rect)
}

export function recallReaderRect(nodeId: string): ReaderRect | undefined {
  return remembered.get(nodeId)
}

/** @internal for tests */
export function forgetReaderRects(): void {
  remembered.clear()
}

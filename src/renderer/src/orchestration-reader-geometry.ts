import {
  NODE_FIT_INSET,
  isMaximised,
  nextSnapSlice,
  sliceGeometry,
  MAXIMISED,
  type SnapArrow,
  type SnapSlice
} from './node-snap'

/**
 * Where the floating questions reader sits and how big it is. Pure, so the window's bounds are one
 * rule: its position never leaves the viewport. Its size has no limit, like a node's. Alt+Arrow and
 * the header's fit button arrange it through the canvas's own slice vocabulary (`node-snap.ts`),
 * in the region a node's fullscreen fills: the canvas on screen, so the sidebar, the top bar and a
 * docked panel stay visible.
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

/**
 * The gap kept between the window and the viewport edge.
 * @internal exported for tests
 */
export const READER_MARGIN = 8

const DEFAULT_SIZE = { width: 520, height: 560 } as const
/** Below the app header, so a fresh window opens over the canvas rather than the title bar. */
const DEFAULT_TOP = 64
/** A window needs some area to be a window at all; that is the only size rule. */
const MIN_EXTENT = 1

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max))
}

/** Keeps the window's top-left inside the viewport, and the whole window when it fits. Size is untouched. */
export function clampReaderRect(rect: ReaderRect, viewport: ReaderViewport): ReaderRect {
  const width = Math.max(MIN_EXTENT, rect.width)
  const height = Math.max(MIN_EXTENT, rect.height)
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

/** Drag of the bottom-right corner: the top-left corner stays and the size follows without limit. */
export function resizeReaderRect(rect: ReaderRect, dx: number, dy: number): ReaderRect {
  return {
    ...rect,
    width: Math.max(MIN_EXTENT, rect.width + dx),
    height: Math.max(MIN_EXTENT, rect.height + dy)
  }
}

/** Where the window is arranged, and where it returns to; session-local like a node's snap state. */
export interface ReaderSnap extends SnapSlice {
  restore: ReaderRect
}

export interface ReaderArrangement {
  rect: ReaderRect
  snap: ReaderSnap | null
}

/** The canvas region in screen coordinates, kept the fit inset away from its edges as a node is. */
function sliceRect(slice: SnapSlice, canvas: ReaderRect): ReaderRect {
  const region = {
    position: { x: canvas.left + NODE_FIT_INSET, y: canvas.top + NODE_FIT_INSET },
    width: Math.max(MIN_EXTENT, canvas.width - NODE_FIT_INSET * 2),
    height: Math.max(MIN_EXTENT, canvas.height - NODE_FIT_INSET * 2)
  }
  const geometry = sliceGeometry(region, slice, NODE_FIT_INSET)
  return { left: geometry.position.x, top: geometry.position.y, width: geometry.width, height: geometry.height }
}

function placed(rect: ReaderRect, snap: ReaderSnap | null, slice: SnapSlice, canvas: ReaderRect): ReaderArrangement {
  return {
    rect: sliceRect(slice, canvas),
    snap: { h: slice.h, v: slice.v, restore: snap?.restore ?? rect }
  }
}

/** One Alt+Arrow press, with the same steps as a node's; null from the slice sequence restores. */
export function snapReaderRect(
  rect: ReaderRect,
  snap: ReaderSnap | null,
  arrow: SnapArrow,
  canvas: ReaderRect
): ReaderArrangement {
  const slice = nextSnapSlice(snap, arrow)
  return slice ? placed(rect, snap, slice, canvas) : { rect: snap?.restore ?? rect, snap: null }
}

/** The header's fit button: fills the canvas as a node's fullscreen does, or restores when it already does. */
export function toggleReaderFit(rect: ReaderRect, snap: ReaderSnap | null, canvas: ReaderRect): ReaderArrangement {
  return isMaximised(snap ?? undefined)
    ? { rect: snap?.restore ?? rect, snap: null }
    : placed(rect, snap, MAXIMISED, canvas)
}

/** A changed canvas or viewport re-lays a snapped window into its slice; a free one is only kept on screen. */
export function reflowReaderRect(
  rect: ReaderRect,
  snap: ReaderSnap | null,
  canvas: ReaderRect,
  viewport: ReaderViewport
): ReaderRect {
  return snap ? sliceRect(snap, canvas) : clampReaderRect(rect, viewport)
}

const remembered = new Map<string, ReaderRect>()

/** Remembered for the app session, per orchestrator node. */
export function rememberReaderRect(nodeId: string, rect: ReaderRect): void {
  remembered.set(nodeId, rect)
}

export function recallReaderRect(nodeId: string): ReaderRect | undefined {
  return remembered.get(nodeId)
}

/** @internal exported for tests */
export function forgetReaderRects(): void {
  remembered.clear()
}

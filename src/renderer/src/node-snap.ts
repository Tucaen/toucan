import type { Node, NodeChange, Viewport } from '@xyflow/react'

export const NODE_FIT_INSET = 16

export interface CanvasSize {
  width: number
  height: number
}

export interface NodeGeometry {
  position: { x: number; y: number }
  width: number
  height: number
}

/** Which part of the visible canvas a snapped node occupies; `full`/`full` is the maximised node. */
export type SnapH = 'full' | 'left' | 'right'
export type SnapV = 'full' | 'top' | 'bottom'
export interface SnapSlice {
  h: SnapH
  v: SnapV
}

export interface SnapState extends SnapSlice {
  /** Session-local, never persisted: where the node was before it was first snapped. */
  restoreGeometry: NodeGeometry
}

/** Every snapped node by id. Empty when nothing is snapped. */
export type SnapStates = Readonly<Record<string, SnapState>>

export type SnapArrow = 'left' | 'right' | 'up' | 'down'

export const MAXIMISED: SnapSlice = { h: 'full', v: 'full' }

export function isMaximised(slice: SnapSlice | undefined): boolean {
  return slice?.h === 'full' && slice.v === 'full'
}

/** Converts the visible canvas rectangle from screen pixels into React Flow coordinates. */
export function canvasRegion(canvas: CanvasSize, viewport: Viewport, inset: number): NodeGeometry {
  return {
    position: {
      x: (inset - viewport.x) / viewport.zoom,
      y: (inset - viewport.y) / viewport.zoom
    },
    width: (canvas.width - inset * 2) / viewport.zoom,
    height: (canvas.height - inset * 2) / viewport.zoom
  }
}

/** The part of the region a slice covers; halves share the inset as their gap. */
export function sliceGeometry(region: NodeGeometry, slice: SnapSlice, gap: number): NodeGeometry {
  const halfWidth = (region.width - gap) / 2
  const halfHeight = (region.height - gap) / 2
  return {
    position: {
      x: region.position.x + (slice.h === 'right' ? halfWidth + gap : 0),
      y: region.position.y + (slice.v === 'bottom' ? halfHeight + gap : 0)
    },
    width: slice.h === 'full' ? region.width : halfWidth,
    height: slice.v === 'full' ? region.height : halfHeight
  }
}

/**
 * Windows Snap, transcribed to the canvas. Left/Right pick a half, and from the opposite half go
 * back to full width. Up from an unsnapped node maximises; from a half it picks the top quarter;
 * from a bottom quarter it returns to the half. Down mirrors Up, and from a maximised node or from
 * the bottom row it restores. Null means "restore"; the same slice means "nothing to do".
 */
export function nextSnapSlice(current: SnapSlice | null, arrow: SnapArrow): SnapSlice | null {
  if (!current) {
    if (arrow === 'left') return { h: 'left', v: 'full' }
    if (arrow === 'right') return { h: 'right', v: 'full' }
    if (arrow === 'up') return MAXIMISED
    return null
  }
  const { h, v } = current
  switch (arrow) {
    case 'left':
      return { h: h === 'right' ? 'full' : 'left', v }
    case 'right':
      return { h: h === 'left' ? 'full' : 'right', v }
    case 'up':
      if (v === 'bottom') return { h, v: 'full' }
      if (v === 'full' && h !== 'full') return { h, v: 'top' }
      return { h, v }
    case 'down':
      if (v === 'top') return { h, v: 'full' }
      if (v === 'full' && h !== 'full') return { h, v: 'bottom' }
      return null
  }
}

/** Captures the geometry React Flow currently renders, regardless of whether it came from style or measurement. */
export function renderedNodeGeometry(node: Node): NodeGeometry | null {
  const width = node.measured?.width ?? (typeof node.style?.width === 'number' ? node.style.width : 0)
  const height = node.measured?.height ?? (typeof node.style?.height === 'number' ? node.style.height : 0)
  return width > 0 && height > 0 ? { position: { ...node.position }, width, height } : null
}

/**
 * Projects geometry onto a React Flow node without changing any other runtime fields. A manual
 * resize leaves the new size on the node's `width`/`height` attributes, and React Flow renders
 * those in preference to `style` - so when they are present they are rewritten as well, or a snap
 * after a resize would move the node while leaving it at its old size.
 */
export function nodeAtGeometry<T extends Node>(node: T, geometry: NodeGeometry): T {
  return {
    ...node,
    position: geometry.position,
    ...(node.width !== undefined ? { width: geometry.width } : {}),
    ...(node.height !== undefined ? { height: geometry.height } : {}),
    style: { ...node.style, width: geometry.width, height: geometry.height },
    measured: { ...node.measured, width: geometry.width, height: geometry.height }
  }
}

/**
 * A maximised node is a way of looking at one session, not an arrangement, so persistence and the
 * recently-closed capture see the geometry it will return to. Halves and quarters are an
 * arrangement and are written exactly as they render.
 */
export function nodeBeforeTemporaryFit<T extends Node>(node: T, snaps: SnapStates): T {
  const snap = snaps[node.id]
  return snap && isMaximised(snap) ? nodeAtGeometry(node, snap.restoreGeometry) : node
}

/** The header action reads this flag; it is presentation only and never serialized. */
function nodeWithFitFlag<T extends Node>(node: T, fitted: boolean): T {
  if ((node.data as { fittedToCanvas?: boolean }).fittedToCanvas === fitted) return node
  return { ...node, data: { ...node.data, fittedToCanvas: fitted } } as T
}

function nodeSnapped<T extends Node>(node: T, slice: SnapSlice, geometry: NodeGeometry): T {
  return nodeAtGeometry(nodeWithFitFlag(node, isMaximised(slice)), geometry)
}

function withoutSnap(snaps: SnapStates, nodeId: string): SnapStates {
  const { [nodeId]: _released, ...rest } = snaps
  return rest
}

export interface SnapResult<T extends Node> {
  nodes: T[]
  snaps: SnapStates
}

function restoreNode<T extends Node>(nodes: T[], snaps: SnapStates, nodeId: string): SnapResult<T> {
  const snap = snaps[nodeId]
  if (!snap) return { nodes, snaps }
  return {
    nodes: nodes.map((node) =>
      node.id === nodeId ? nodeAtGeometry(nodeWithFitFlag(node, false), snap.restoreGeometry) : node
    ),
    snaps: withoutSnap(snaps, nodeId)
  }
}

function sameSlice(a: SnapSlice, b: SnapSlice): boolean {
  return a.h === b.h && a.v === b.v
}

/**
 * Moves `nodeId` into `slice`. One node per slice: any other node already in that slice is
 * restored first, which is what keeps "at most one maximised node" true without the caller
 * tracking it, and stops two half-snapped nodes from hiding each other. A node without
 * measurable geometry has nothing to return to and is left alone.
 */
export function snapNodeToSlice<T extends Node>(
  nodes: T[],
  snaps: SnapStates,
  nodeId: string,
  slice: SnapSlice,
  region: NodeGeometry,
  gap: number
): SnapResult<T> {
  const target = nodes.find((node) => node.id === nodeId)
  const current = target ? renderedNodeGeometry(target) : null
  if (!current) return { nodes, snaps }
  let result: SnapResult<T> = { nodes, snaps }
  for (const [otherId, other] of Object.entries(snaps)) {
    if (otherId !== nodeId && sameSlice(other, slice)) result = restoreNode(result.nodes, result.snaps, otherId)
  }
  const geometry = sliceGeometry(region, slice, gap)
  return {
    nodes: result.nodes.map((node) => (node.id === nodeId ? nodeSnapped(node, slice, geometry) : node)),
    snaps: { ...result.snaps, [nodeId]: { ...slice, restoreGeometry: snaps[nodeId]?.restoreGeometry ?? current } }
  }
}

/** One arrow press on a single node: steps through `nextSnapSlice`, restoring when it says so. */
export function snapNode<T extends Node>(
  nodes: T[],
  snaps: SnapStates,
  nodeId: string,
  arrow: SnapArrow,
  region: NodeGeometry,
  gap: number
): SnapResult<T> {
  const slice = nextSnapSlice(snaps[nodeId] ?? null, arrow)
  if (slice === null) return restoreNode(nodes, snaps, nodeId)
  return snapNodeToSlice(nodes, snaps, nodeId, slice, region, gap)
}

/**
 * Two nodes at once: Left/Right puts them side by side, Up/Down stacks them. Which one takes the
 * first slice follows their current order on the canvas, so the pair never swaps places.
 */
export function snapNodePair<T extends Node>(
  nodes: T[],
  snaps: SnapStates,
  ids: readonly [string, string],
  arrow: SnapArrow,
  region: NodeGeometry,
  gap: number
): SnapResult<T> {
  const pair = ids.map((id) => nodes.find((node) => node.id === id)).filter((node): node is T => !!node)
  if (pair.length !== 2) return { nodes, snaps }
  const horizontal = arrow === 'left' || arrow === 'right'
  const [first, second] = [...pair].sort((a, b) =>
    horizontal ? a.position.x - b.position.x : a.position.y - b.position.y
  )
  const slices: [SnapSlice, SnapSlice] = horizontal
    ? [
        { h: 'left', v: 'full' },
        { h: 'right', v: 'full' }
      ]
    : [
        { h: 'full', v: 'top' },
        { h: 'full', v: 'bottom' }
      ]
  const one = snapNodeToSlice(nodes, snaps, first.id, slices[0], region, gap)
  return snapNodeToSlice(one.nodes, one.snaps, second.id, slices[1], region, gap)
}

/** Maximises the node, or restores it when it is the maximised one - the header action. */
export function toggleNodeFit<T extends Node>(
  nodes: T[],
  snaps: SnapStates,
  nodeId: string,
  region: NodeGeometry,
  gap: number
): SnapResult<T> {
  if (isMaximised(snaps[nodeId])) return restoreNode(nodes, snaps, nodeId)
  return snapNodeToSlice(nodes, snaps, nodeId, MAXIMISED, region, gap)
}

/**
 * Recomputes every snapped node's geometry for a changed usable canvas - an application resize, a
 * sidebar toggle, a docked panel. It reads the caller's current pan and zoom and never writes
 * them, so the viewport stays exactly where the user left it. A canvas with no room for the inset
 * (a hidden or not-yet-laid-out region) is ignored rather than collapsing the nodes.
 */
export function reflowSnappedNodes<T extends Node>(
  nodes: T[],
  snaps: SnapStates,
  canvas: CanvasSize,
  viewport: Viewport,
  inset: number
): T[] {
  if (Object.keys(snaps).length === 0 || canvas.width <= inset * 2 || canvas.height <= inset * 2) return nodes
  const region = canvasRegion(canvas, viewport, inset)
  return nodes.map((node) => {
    const snap = snaps[node.id]
    return snap ? nodeAtGeometry(node, sliceGeometry(region, snap, inset)) : node
  })
}

/**
 * Which snapped nodes one batch of React Flow changes takes back: a node the user dragged or
 * resized is theirs again, and a removed node needs no restore waiting for it. Only a drag or an
 * active resize counts as the user changing geometry: React Flow also reports measurement as a
 * dimension change, and snapping the node is what produced that measurement.
 */
export function snapsReleasedByChanges(changes: NodeChange[], snaps: SnapStates): string[] {
  const released = new Set<string>()
  for (const change of changes) {
    if (change.type === 'add' || !snaps[change.id]) continue
    if (
      change.type === 'remove' ||
      (change.type === 'position' && change.dragging === true) ||
      (change.type === 'dimensions' && change.resizing === true)
    )
      released.add(change.id)
  }
  return [...released]
}

/** Forgets the snaps without moving the nodes, so the geometry the user just produced survives. */
export function releaseSnaps<T extends Node>(nodes: T[], snaps: SnapStates, ids: readonly string[]): SnapResult<T> {
  if (ids.length === 0) return { nodes, snaps }
  const releasing = new Set(ids)
  let rest = snaps
  for (const id of ids) rest = withoutSnap(rest, id)
  return { nodes: nodes.map((node) => (releasing.has(node.id) ? nodeWithFitFlag(node, false) : node)), snaps: rest }
}

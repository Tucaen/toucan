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

/**
 * The one node the workspace keeps fitted, plus the geometry a restore must return it to. There is
 * at most one, so fitting a second node restores the first rather than leaving two nodes claiming
 * the whole canvas.
 */
export interface NodeFitState {
  nodeId: string
  /** Session-local, never persisted: it is where the node was before the canvas swallowed it. */
  restoreGeometry: NodeGeometry
}

/** Converts the visible canvas rectangle from screen pixels into React Flow coordinates. */
export function fitNodeToCanvas(canvas: CanvasSize, viewport: Viewport, inset: number): NodeGeometry {
  return {
    position: {
      x: (inset - viewport.x) / viewport.zoom,
      y: (inset - viewport.y) / viewport.zoom
    },
    width: (canvas.width - inset * 2) / viewport.zoom,
    height: (canvas.height - inset * 2) / viewport.zoom
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
 * those in preference to `style` - so when they are present they are rewritten as well, or a fit
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

/** Removes the temporary fitted projection before persistence or recently-closed capture. */
export function nodeBeforeTemporaryFit<T extends Node>(node: T, fit: NodeFitState | null): T {
  return fit && fit.nodeId === node.id ? nodeAtGeometry(node, fit.restoreGeometry) : node
}

/** The header action reads this flag; it is presentation only and never serialized. */
function nodeWithFitFlag<T extends Node>(node: T, fitted: boolean): T {
  if ((node.data as { fittedToCanvas?: boolean }).fittedToCanvas === fitted) return node
  return { ...node, data: { ...node.data, fittedToCanvas: fitted } } as T
}

function restoreFittedNode<T extends Node>(nodes: T[], fit: NodeFitState): T[] {
  return nodes.map((node) =>
    node.id === fit.nodeId ? nodeAtGeometry(nodeWithFitFlag(node, false), fit.restoreGeometry) : node
  )
}

export interface NodeFitRequestResult<T extends Node> {
  nodes: T[]
  fit: NodeFitState | null
}

/**
 * Fits one node, or restores it when it is already the fitted one. Any other fitted node is
 * restored first, which is what keeps "at most one fitted node" true without the caller tracking
 * it. Returns the inputs unchanged when the requested node has no measurable geometry to save.
 */
export function requestNodeFit<T extends Node>(
  nodes: T[],
  fit: NodeFitState | null,
  nodeId: string,
  canvas: CanvasSize,
  viewport: Viewport,
  inset: number
): NodeFitRequestResult<T> {
  if (fit?.nodeId === nodeId) return { nodes: restoreFittedNode(nodes, fit), fit: null }
  const target = nodes.find((node) => node.id === nodeId)
  const current = target ? renderedNodeGeometry(target) : null
  if (!current) return { nodes, fit }
  const geometry = fitNodeToCanvas(canvas, viewport, inset)
  const restored = fit ? restoreFittedNode(nodes, fit) : nodes
  return {
    nodes: restored.map((node) => (node.id === nodeId ? nodeAtGeometry(nodeWithFitFlag(node, true), geometry) : node)),
    fit: { nodeId, restoreGeometry: { ...current, position: { ...current.position } } }
  }
}

/**
 * Recomputes the fitted node's geometry for a changed usable canvas - an application resize, a
 * sidebar toggle, the docked brain-dump panel. It reads the caller's current pan and zoom and
 * never writes them, so the viewport stays exactly where the user left it. A canvas with no room
 * for the inset (a hidden or not-yet-laid-out region) is ignored rather than collapsing the node.
 */
export function reflowFittedNode<T extends Node>(
  nodes: T[],
  fit: NodeFitState | null,
  canvas: CanvasSize,
  viewport: Viewport,
  inset: number
): T[] {
  if (!fit || canvas.width <= inset * 2 || canvas.height <= inset * 2) return nodes
  const geometry = fitNodeToCanvas(canvas, viewport, inset)
  return nodes.map((node) => (node.id === fit.nodeId ? nodeAtGeometry(node, geometry) : node))
}

/**
 * What one batch of React Flow changes does to fit mode: 'exit' when the user moved or resized the
 * fitted node themselves, 'forget' when it is being removed, 'keep' otherwise. Every change type
 * fit mode cares about is decided here, so a new rule never has to be added in two places.
 *
 * Only a drag or an active resize counts as the user changing geometry: React Flow also reports
 * measurement as a dimension change, and fitting the node is what produced that measurement.
 */
export function nodeFitAfterChanges(changes: NodeChange[], fit: NodeFitState | null): 'keep' | 'exit' | 'forget' {
  if (!fit) return 'keep'
  for (const change of changes) {
    if (change.type === 'remove' && change.id === fit.nodeId) return 'forget'
  }
  const exits = changes.some(
    (change) =>
      (change.type === 'position' && change.id === fit.nodeId && change.dragging === true) ||
      (change.type === 'dimensions' && change.id === fit.nodeId && change.resizing === true)
  )
  return exits ? 'exit' : 'keep'
}

/** Leaves fit mode without moving the node, so the geometry the user just produced survives. */
export function clearNodeFitFlag<T extends Node>(nodes: T[], nodeId: string): T[] {
  return nodes.map((node) => (node.id === nodeId ? nodeWithFitFlag(node, false) : node))
}

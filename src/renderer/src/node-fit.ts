import type { Node, Viewport } from '@xyflow/react'

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

export interface NodeFitTransition {
  geometry: NodeGeometry
  restoreGeometry?: NodeGeometry
  fitted: boolean
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

/** One fit/restore state transition. The caller owns the session-local restore snapshot. */
export function toggleNodeFit(
  current: NodeGeometry,
  restoreGeometry: NodeGeometry | undefined,
  canvas: CanvasSize,
  viewport: Viewport,
  inset: number
): NodeFitTransition {
  if (restoreGeometry) return { geometry: restoreGeometry, fitted: false }
  return {
    geometry: fitNodeToCanvas(canvas, viewport, inset),
    restoreGeometry: { ...current, position: { ...current.position } },
    fitted: true
  }
}

/** Projects geometry onto a React Flow node without changing any other runtime fields. */
export function nodeAtGeometry<T extends Node>(node: T, geometry: NodeGeometry): T {
  return {
    ...node,
    position: geometry.position,
    style: { ...node.style, width: geometry.width, height: geometry.height },
    measured: { ...node.measured, width: geometry.width, height: geometry.height }
  }
}

/** Removes the temporary fitted projection before persistence or recently-closed capture. */
export function nodeBeforeTemporaryFit<T extends Node>(node: T, restoreGeometry: NodeGeometry | undefined): T {
  return restoreGeometry ? nodeAtGeometry(node, restoreGeometry) : node
}

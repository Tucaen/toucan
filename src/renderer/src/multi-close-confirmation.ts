/**
 * Closing more than one node in a single action asks first.
 *
 * React Flow awaits `onBeforeDelete` with everything a delete would remove - the selection plus
 * whatever it takes along - before it emits any `remove` change, so this is the one seam every
 * user-driven close passes through, on the main canvas and inside a worktree. Programmatic closes
 * (ticket cleanup, a session closing itself) call the node handler directly and never reach it.
 * Declining resolves to nothing removed at all: a cancelled close must leave nodes and edges alone.
 */
import type { CanvasNode } from './canvas-workspace'

export interface PendingMultiClose {
  /** Display names of every node the action would close, in canvas order. */
  labels: string[]
}

export interface DeleteSet<N, E> {
  nodes: N[]
  edges: E[]
}

/** True when this action would close more than one node, and so must be confirmed. */
export function needsMultiCloseConfirmation(nodes: readonly unknown[]): boolean {
  return nodes.length > 1
}

export function multiCloseLabels(nodes: readonly CanvasNode[]): string[] {
  return nodes.map((node) => {
    const label: unknown = node.data.label
    return typeof label === 'string' && label.trim() ? label.trim() : 'Untitled node'
  })
}

/**
 * Wraps a `beforeDelete` stage so that a result of two or more nodes goes through `confirm` first.
 * `confirm` resolves true to proceed; anything else (Cancel, Escape, a dismissed dialog) removes
 * nothing. A single node, or none, passes through untouched.
 */
export function withMultiCloseConfirmation<N extends CanvasNode, E>(
  stage: (params: DeleteSet<N, E>) => Promise<DeleteSet<N, E>>,
  confirm: (pending: PendingMultiClose) => Promise<boolean>
): (params: DeleteSet<N, E>) => Promise<DeleteSet<N, E>> {
  return async (params) => {
    const result = await stage(params)
    if (!needsMultiCloseConfirmation(result.nodes)) return result
    const confirmed = await confirm({ labels: multiCloseLabels(result.nodes) })
    return confirmed ? result : { nodes: [], edges: [] }
  }
}

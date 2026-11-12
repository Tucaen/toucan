/**
 * Closing more than one node in a single action asks first, and so does closing an orchestrator
 * whose ticket sessions still sit in worktrees: those worktrees outlive it with nothing left to
 * merge or clean them up.
 *
 * React Flow awaits `onBeforeDelete` with everything a delete would remove - the selection plus
 * whatever it takes along - before it emits any `remove` change, so this is the one seam every
 * user-driven close passes through, on the main canvas and inside a worktree. Programmatic closes
 * (ticket cleanup, a session closing itself) call the node handler directly and never reach it.
 * Declining resolves to nothing removed at all: a cancelled close must leave nodes and edges alone.
 */
import { isTerminalCanvasNode, isWorktreeCanvasNode, type CanvasNode } from './canvas-workspace'

export interface PendingMultiClose {
  /** Display names of every node the action would close, in canvas order. */
  labels: string[]
  /** Branches of the worktrees a closing orchestrator leaves behind; empty when it leaves none. */
  orphanedWorktrees: string[]
}

export interface DeleteSet<N, E> {
  nodes: N[]
  edges: E[]
}

/** True when this action would close more than one node or orphan a worktree, and so must be confirmed. */
function needsConfirmation(pending: PendingMultiClose): boolean {
  return pending.labels.length > 1 || pending.orphanedWorktrees.length > 0
}

/**
 * The worktrees that hold a ticket session of an orchestrator in `closing`, in canvas order. A
 * worktree closed by the same action is left out: it is not left behind.
 *
 * @internal exported for tests
 */
export function orphanedWorktrees(closing: readonly CanvasNode[], canvas: readonly CanvasNode[]): string[] {
  const orchestrators = new Set(
    closing.filter((node) => isTerminalCanvasNode(node) && node.data.role === 'orchestrator').map((node) => node.id)
  )
  if (orchestrators.size === 0) return []
  const closingIds = new Set(closing.map((node) => node.id))
  const held = new Set(
    canvas
      .filter(isTerminalCanvasNode)
      .filter((node) => node.data.orchestratedBy && orchestrators.has(node.data.orchestratedBy.nodeId))
      .map((node) => node.data.worktreeId)
      .filter((worktreeId): worktreeId is string => Boolean(worktreeId))
  )
  return canvas
    .filter(isWorktreeCanvasNode)
    .filter((node) => held.has(node.data.worktreeId) && !closingIds.has(node.id))
    .map((node) => node.data.branch || node.data.worktreeId)
}

export function multiCloseLabels(nodes: readonly CanvasNode[]): string[] {
  return nodes.map((node) => {
    const label: unknown = node.data.label
    return typeof label === 'string' && label.trim() ? label.trim() : 'Untitled node'
  })
}

/**
 * Wraps a `beforeDelete` stage so that a result of two or more nodes, or one that orphans a
 * worktree, goes through `confirm` first. `canvas` reads every node on every canvas, since an
 * orchestrator's ticket sessions live inside worktrees rather than beside it. `confirm` resolves
 * true to proceed; anything else (Cancel, Escape, a dismissed dialog) removes nothing. A single
 * node that orphans nothing, or none, passes through untouched.
 */
export function withMultiCloseConfirmation<N extends CanvasNode, E>(
  stage: (params: DeleteSet<N, E>) => Promise<DeleteSet<N, E>>,
  confirm: (pending: PendingMultiClose) => Promise<boolean>,
  canvas: () => readonly CanvasNode[]
): (params: DeleteSet<N, E>) => Promise<DeleteSet<N, E>> {
  return async (params) => {
    const result = await stage(params)
    const pending = {
      labels: multiCloseLabels(result.nodes),
      orphanedWorktrees: orphanedWorktrees(result.nodes, canvas())
    }
    if (!needsConfirmation(pending)) return result
    const confirmed = await confirm(pending)
    return confirmed ? result : { nodes: [], edges: [] }
  }
}

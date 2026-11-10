import type { WorkspaceProject } from '../../shared/workspace'
import { worktreePathKey } from '../../shared/worktree'
import type { CanvasNode, TerminalNodeStatus, WorktreeCanvasNode } from './canvas-workspace'
import { isTerminalCanvasNode, isWorktreeCanvasNode, withoutWorktree } from './canvas-workspace'

/**
 * What it takes for a node to be *in* a worktree: attachment (`worktreeId`) is what makes a node
 * run there, and the count a worktree shows is derived from the nodes that genuinely do.
 */

/**
 * A session may only be restarted when nothing is in flight to lose. `working`/`starting` have a
 * turn or a handshake running, `attention` has a request waiting for the user, and `stalled` is a
 * turn Toucan cannot prove is finished - all of them wait for the next boundary.
 *
 * Exported because branching a conversation (`conversation-lineage.ts`) needs the same boundary
 * for a different reason - the transcript on disk a fork copies is only complete between turns -
 * and two lists that must agree would sooner or later stop agreeing.
 */
export const ADOPTION_BOUNDARY: readonly TerminalNodeStatus[] = ['idle', 'result', 'dormant', 'exited']

/** Creation can finish after discovery: preserve the existing id and every reference to it. */
export function registerWorktreeNode(nodes: CanvasNode[], incoming: WorktreeCanvasNode): CanvasNode[] {
  const existing = nodes
    .filter(isWorktreeCanvasNode)
    .find(
      (node) =>
        node.data.projectId === incoming.data.projectId &&
        worktreePathKey(node.data.path) === worktreePathKey(incoming.data.path)
    )
  if (!existing) return [...nodes, incoming]
  return nodes.map((node) =>
    node === existing
      ? {
          ...existing,
          selected: incoming.selected,
          data: {
            ...existing.data,
            branch: incoming.data.branch,
            baseRef: incoming.data.baseRef,
            unavailable: undefined
          }
        }
      : node
  )
}

/** Never change a running session's cwd or stop it as a side effect of background discovery. */
export function reconcileStaleWorktrees(
  nodes: CanvasNode[],
  projectId: string,
  paths: readonly string[],
  availablePaths: readonly string[] = []
): CanvasNode[] {
  const stale = new Set(paths.map(worktreePathKey))
  const available = new Set(availablePaths.map(worktreePathKey))
  const attached = new Set(nodes.filter(isTerminalCanvasNode).map((node) => node.data.worktreeId))
  const removed = new Set(
    nodes
      .filter(isWorktreeCanvasNode)
      .filter(
        (node) =>
          node.data.projectId === projectId &&
          stale.has(worktreePathKey(node.data.path)) &&
          !attached.has(node.data.worktreeId)
      )
      .map((node) => node.data.worktreeId)
  )
  let next = nodes
  for (const id of removed) next = withoutWorktree(next, id)
  return next.map((node) =>
    isWorktreeCanvasNode(node) &&
    node.data.projectId === projectId &&
    node.data.unavailable &&
    available.has(worktreePathKey(node.data.path))
      ? { ...node, data: { ...node.data, unavailable: undefined } }
      : isWorktreeCanvasNode(node) &&
          node.data.projectId === projectId &&
          !node.data.unavailable &&
          stale.has(worktreePathKey(node.data.path))
        ? { ...node, data: { ...node.data, unavailable: true } }
        : node
  )
}

/**
 * One place decides how many nodes a worktree carries, so the count the teardown gate reads and
 * the count the node shows can never drift apart. An association is not a node running in the
 * worktree and is deliberately not counted. Returns the same array when nothing changed, so the
 * canvas is not re-rendered for a recount that found the same numbers.
 */
export function applyAttachedNodeCounts(nodes: CanvasNode[], projects: readonly WorkspaceProject[]): CanvasNode[] {
  const counts = new Map<string, number>()
  for (const node of nodes) {
    if (isTerminalCanvasNode(node) && node.data.worktreeId) {
      counts.set(node.data.worktreeId, (counts.get(node.data.worktreeId) ?? 0) + 1)
    }
  }

  let changed = false
  const next = nodes.map((node) => {
    if (!isWorktreeCanvasNode(node)) return node
    const setupCommand = projects.find((candidate) => candidate.id === node.data.projectId)?.setupCommand
    const attachedNodeCount = counts.get(node.data.worktreeId) ?? 0
    if (node.data.attachedNodeCount === attachedNodeCount && node.data.setupCommand === setupCommand) return node
    changed = true
    return { ...node, data: { ...node.data, attachedNodeCount, setupCommand } }
  })
  return changed ? next : nodes
}

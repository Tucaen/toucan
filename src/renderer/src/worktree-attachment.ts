import type { WorkspaceProject } from '../../shared/terminal'
import type { WorktreeClaimMatch } from '../../shared/worktree'
import type { CanvasNode, TerminalNodeStatus } from './canvas-workspace'
import { isTerminalCanvasNode, isWorktreeCanvasNode } from './canvas-workspace'

/**
 * What it takes for a node to be *in* a worktree rather than merely linked to one.
 *
 * Discovery can only ever tell that a worktree exists and which node's claim names it, so the
 * association it records (`activeWorktreeId`) is deliberately weak: it changes nothing about
 * where the session runs. This module is where that association is redeemed - the node moves
 * into the worktree - and where the count a worktree shows is derived from the nodes that
 * genuinely run in it.
 */

/**
 * Moving a node into a worktree restarts its session there, so it may only happen when nothing
 * is in flight to lose. `working`/`starting` have a turn or a handshake running, `attention` has
 * a request waiting for the user, and `stalled` is a turn Toucan cannot prove is finished - all
 * of them keep the association and try again at the next boundary.
 */
const ADOPTION_BOUNDARY: readonly TerminalNodeStatus[] = ['idle', 'result', 'dormant', 'exited']

/** Paths reach the workspace from git and from the agent's claim in different shapes. */
function comparablePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

/**
 * Links each claim to the node that wrote it. This is only the weak association: it says which
 * worktree a node started work in, and changes nothing about where the node runs - redeeming it
 * is `adoptClaimedWorktrees`' job, at a boundary where the move is safe. A node that already
 * runs in a worktree is never re-linked, which is also what stops a spent claim from coming
 * back: the claims file is appended to by agents and never pruned.
 */
export function applyWorktreeClaims(nodes: CanvasNode[], claims: readonly WorktreeClaimMatch[]): CanvasNode[] {
  if (claims.length === 0) return nodes
  const worktreesByPath = new Map(
    nodes.filter(isWorktreeCanvasNode).map((node) => [comparablePath(node.data.path), node.data])
  )
  const claimedBy = new Map(claims.map((claim) => [claim.nodeId, worktreesByPath.get(comparablePath(claim.path))]))

  let changed = false
  const next = nodes.map<CanvasNode>((node) => {
    if (!isTerminalCanvasNode(node) || node.data.worktreeId) return node
    const worktree = claimedBy.get(node.id)
    if (!worktree || worktree.projectId !== node.data.projectId) return node
    if (node.data.activeWorktreeId === worktree.worktreeId) return node
    changed = true
    return {
      ...node,
      data: { ...node.data, activeWorktreeId: worktree.worktreeId, activeWorktreeBranch: worktree.branch }
    }
  })
  return changed ? next : nodes
}

export interface WorktreeAdoption {
  nodeId: string
  worktreeId: string
  branch: string
  path: string
}

/**
 * The claimed associations that are ready to become attachments. Only Codex: loading a
 * conversation in a directory it did not start in works there, which is the whole reason a
 * Codex node can move at all. A Claude node keeps the association and stays where it is,
 * exactly as its handoff rules already require.
 */
export function planWorktreeAdoptions(
  nodes: CanvasNode[],
  statuses: Readonly<Record<string, TerminalNodeStatus>>
): WorktreeAdoption[] {
  const worktrees = new Map(nodes.filter(isWorktreeCanvasNode).map((node) => [node.data.worktreeId, node.data]))

  return nodes.filter(isTerminalCanvasNode).flatMap((node) => {
    const { activeWorktreeId, worktreeId, kind, dormant, detachedFromWorktree } = node.data
    if (!activeWorktreeId || worktreeId || detachedFromWorktree || kind !== 'codex') return []
    const worktree = worktrees.get(activeWorktreeId)
    // A claim is a file any agent may append to, so a node is only ever moved into a worktree
    // of the project it already belongs to - a stale entry cannot relocate it across projects.
    if (!worktree || worktree.projectId !== node.data.projectId) return []
    const status = statuses[node.id] ?? (dormant ? 'dormant' : 'starting')
    if (!ADOPTION_BOUNDARY.includes(status)) return []
    return [{ nodeId: node.id, worktreeId: activeWorktreeId, branch: worktree.branch, path: worktree.path }]
  })
}

/**
 * Applies those adoptions. `workingDirectory` is a dependency of the session effect, so writing
 * it is what actually restarts the session in the worktree, and `resume` makes that restart load
 * the conversation rather than begin a new one - the same move `rehome` makes when the skill is
 * recognised up front. The spent association is cleared so the node is adopted exactly once.
 */
export function adoptClaimedWorktrees(
  nodes: CanvasNode[],
  statuses: Readonly<Record<string, TerminalNodeStatus>>
): CanvasNode[] {
  const adoptions = new Map(planWorktreeAdoptions(nodes, statuses).map((adoption) => [adoption.nodeId, adoption]))
  if (adoptions.size === 0) return nodes

  return nodes.map<CanvasNode>((node) => {
    if (!isTerminalCanvasNode(node)) return node
    const adoption = adoptions.get(node.id)
    if (!adoption) return node
    return {
      ...node,
      data: {
        ...node.data,
        worktreeId: adoption.worktreeId,
        worktreeBranch: adoption.branch,
        workingDirectory: adoption.path,
        activeWorktreeId: undefined,
        activeWorktreeBranch: undefined,
        launchMode: 'resume' as const
      }
    }
  })
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

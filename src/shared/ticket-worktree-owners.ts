import { ORCHESTRATOR_ROLE } from './orchestration'

/**
 * The slice of a canvas node that decides who owns a ticket worktree. Both the desktop canvas
 * nodes and the saved workspace nodes reduce to this, so the sidebar and the phone's chat list
 * read one ownership rule instead of two copies of it.
 */
export type OwnershipNode =
  | {
      kind: 'chat'
      id: string
      projectId: string
      worktreeId?: string
      role?: string
      orchestratedBy?: { nodeId: string }
    }
  | { kind: 'worktree'; worktreeId: string; projectId: string }

/**
 * Which orchestrator owns each worktree: the one named by `orchestratedBy` on a ticket session
 * that runs in it, which Toucan writes when it spawns the session and persists with the node. The
 * first such session in node order whose link is accepted decides when sessions disagree. The link only counts when its
 * orchestrator is a live orchestrator node of the same project, and never when honoring it would
 * make a worktree a descendant of itself (an orchestrator inside its own ticket worktree, or two
 * orchestrators each living in the other's); a refused link leaves that worktree top-level, so
 * nothing is ever hidden. Returns worktree id -> owning orchestrator's node id.
 */
export function ticketWorktreeOwners(nodes: readonly OwnershipNode[]): Map<string, string> {
  const orchestrators = new Map<string, { projectId: string; worktreeId: string | undefined }>()
  for (const node of nodes) {
    if (node.kind === 'chat' && node.role === ORCHESTRATOR_ROLE) {
      orchestrators.set(node.id, { projectId: node.projectId, worktreeId: node.worktreeId })
    }
  }
  const worktreeProjects = new Map<string, string>()
  for (const node of nodes) {
    if (node.kind === 'worktree') worktreeProjects.set(node.worktreeId, node.projectId)
  }
  const owners = new Map<string, string>()
  const hostOf = (worktreeId: string): string | undefined => {
    const owner = owners.get(worktreeId)
    return owner === undefined ? undefined : orchestrators.get(owner)?.worktreeId
  }
  for (const node of nodes) {
    if (node.kind !== 'chat' || !node.worktreeId || !node.orchestratedBy) continue
    const ticketWorktree = node.worktreeId
    if (owners.has(ticketWorktree)) continue
    const owner = orchestrators.get(node.orchestratedBy.nodeId)
    if (!owner || owner.projectId !== worktreeProjects.get(ticketWorktree)) continue
    // Walk up the worktrees the owner is nested in; meeting the ticket worktree is a loop.
    let loops = false
    for (let host = owner.worktreeId; host !== undefined && !loops; host = hostOf(host)) {
      loops = host === ticketWorktree
    }
    if (!loops) owners.set(ticketWorktree, node.orchestratedBy.nodeId)
  }
  return owners
}

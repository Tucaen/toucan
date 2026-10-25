import { isAgentProvider } from '../shared/agent-provider'
import { ORCHESTRATOR_ROLE } from '../shared/orchestration'
import type { WorkspaceState, WorkspaceTerminalNode } from '../shared/workspace'
import type { MessagingDirectory, MessagingDirectoryEntry } from './session-messenger'

/**
 * The canvas's chat sessions as messaging (#2) sees them, read from the persisted workspace per
 * call: the snapshot is the only main-side place a node's project, title and worktree are known,
 * like the outcome index's worktree lookup. What the snapshot does not hold - a ticket session's
 * ticket id, a primary checkout's branch, when a closed session was last active - is asked of the
 * injected lookups, each of which may answer nothing.
 */
export interface MessagingDirectoryOptions {
  workspace(): Promise<WorkspaceState | null | undefined>
  /** The orchestration ticket a ticket session works on. */
  ticketIdFor?(node: WorkspaceTerminalNode): Promise<string | undefined>
  /** The branch of a checkout; a worktree node's own branch is read from its record instead. */
  branchOf?(path: string): Promise<string | undefined>
  /** When the node's conversation last ended a turn, from its outcome record. */
  updatedAtFor?(node: WorkspaceTerminalNode): Promise<string | undefined>
}

export function createMessagingDirectory(options: MessagingDirectoryOptions): MessagingDirectory {
  const describe = async (
    node: WorkspaceTerminalNode,
    state: WorkspaceState,
    branches: Map<string, Promise<string | undefined>>
  ): Promise<MessagingDirectoryEntry | undefined> => {
    if (!isAgentProvider(node.kind)) return undefined
    const role = node.role === ORCHESTRATOR_ROLE ? 'orchestrator' : node.orchestratedBy ? 'ticket' : 'chat'
    const worktree = node.worktreeId ? state.worktrees.find((entry) => entry.id === node.worktreeId) : undefined
    const checkout = state.projects.find((project) => project.id === node.projectId)?.path
    let branch: Promise<string | undefined> | undefined
    if (worktree) branch = Promise.resolve(worktree.branch)
    else if (checkout && options.branchOf) {
      // Asked once per checkout per call: every chat of a project usually shares it.
      branch = branches.get(checkout) ?? options.branchOf(checkout).catch(() => undefined)
      branches.set(checkout, branch)
    }
    const [ticketId, branchName, updatedAt] = await Promise.all([
      role === 'ticket' ? options.ticketIdFor?.(node).catch(() => undefined) : undefined,
      branch,
      options.updatedAtFor?.(node).catch(() => undefined)
    ])
    return {
      nodeId: node.id,
      projectId: node.projectId,
      provider: node.kind,
      role,
      title: node.label,
      ...(ticketId !== undefined ? { ticketId } : {}),
      ...(branchName !== undefined ? { branch: branchName } : {}),
      ...(updatedAt !== undefined ? { updatedAt } : {})
    }
  }

  return {
    async entry(nodeId) {
      const state = await options.workspace()
      const node = state?.nodes.find((candidate) => candidate.id === nodeId)
      return state && node ? describe(node, state, new Map()) : undefined
    },
    async project(projectId) {
      const state = await options.workspace()
      if (!state) return []
      const branches = new Map<string, Promise<string | undefined>>()
      const entries = await Promise.all(
        state.nodes.filter((node) => node.projectId === projectId).map((node) => describe(node, state, branches))
      )
      return entries.filter((entry): entry is MessagingDirectoryEntry => entry !== undefined)
    }
  }
}

/** The ids of the canvas's chat nodes, for `SessionMessenger.nodesChanged`. */
export function chatNodeIds(state: Pick<WorkspaceState, 'nodes'>): Set<string> {
  return new Set(state.nodes.filter((node) => isAgentProvider(node.kind)).map((node) => node.id))
}

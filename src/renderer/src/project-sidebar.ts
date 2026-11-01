/**
 * The projection the project sidebar renders: per-project summaries of the canvas, derived once
 * per render from the nodes and their live statuses. The sidebar itself never sees a canvas node -
 * it reads rows - which is what keeps `ProjectSidebar` mountable without React Flow. It also
 * derives which project the sidebar follows from the canvas selection (`projectOfSelection`).
 */
import { ORCHESTRATOR_ROLE } from '../../shared/orchestration'
import {
  ticketWorktreeOwners as sharedTicketWorktreeOwners,
  type OwnershipNode
} from '../../shared/ticket-worktree-owners'
import type { TerminalKind, TerminalLiveness } from '../../shared/terminal'
import {
  isChatCanvasNode,
  isTerminalCanvasNode,
  isWorktreeCanvasNode,
  sessionNodeStatus,
  type CanvasNode,
  type TerminalNodeStatus
} from './canvas-workspace'

export interface SidebarSessionRow {
  id: string
  label: string
  kind: TerminalKind
  /** An orchestrator's chat, flagged so its row carries the orchestrator glyph instead of the kind icon. */
  orchestrator?: boolean
  selected: boolean
  status: TerminalNodeStatus
  terminalLiveness: TerminalLiveness | undefined
  /**
   * The worktrees spawned for this orchestrator's ticket sessions, in canvas order; empty for
   * every other session. They are listed under it, not under the project - see
   * `projectSidebarSummaries` for what makes an orchestrator their owner.
   */
  ticketWorktrees: SidebarWorktreeRow[]
}

export interface SidebarWorktreeRow {
  id: string
  branch: string
  path: string
  selected: boolean
  collapsed: boolean
  attachedNodeCount: number
  /** The sessions attached to this worktree, in canvas order; they are listed under it, not the project. */
  sessions: SidebarSessionRow[]
}

export interface SidebarProjectSummary {
  /** Sessions not attached to any listed worktree. */
  sessions: SidebarSessionRow[]
  /** The worktrees no orchestrator owns; an owned one is under its orchestrator's `ticketWorktrees`. */
  worktrees: SidebarWorktreeRow[]
  /** Sessions plus worktrees - what the locate button counts and the remove button guards on. */
  nodeCount: number
  /** Every session node id, worktree ones included, for counting and describing unread records. */
  sessionNodeIds: string[]
}

const EMPTY_SUMMARY: SidebarProjectSummary = { sessions: [], worktrees: [], nodeCount: 0, sessionNodeIds: [] }

/** A project with no nodes still renders a row, so a missing summary reads as an empty one. */
export function sidebarSummaryFor(
  summaries: ReadonlyMap<string, SidebarProjectSummary>,
  projectId: string
): SidebarProjectSummary {
  return summaries.get(projectId) ?? EMPTY_SUMMARY
}

/**
 * The project the canvas selection belongs to, which the sidebar follows so a node created next
 * lands where the user is looking. A selection spanning projects names none - the sidebar keeps
 * what it had rather than picking one of them.
 */
export function projectOfSelection(nodes: readonly CanvasNode[]): string | undefined {
  const projects = new Set(nodes.filter((node) => node.selected).map((node) => node.data.projectId))
  return projects.size === 1 ? [...projects][0] : undefined
}

/**
 * Which orchestrator owns each worktree, for the canvas nodes; the rule itself is shared with the
 * phone's chat list (`shared/ticket-worktree-owners.ts`). Returns worktree id -> orchestrator node id.
 */
export function ticketWorktreeOwners(nodes: readonly CanvasNode[]): Map<string, string> {
  const ownership: OwnershipNode[] = []
  for (const node of nodes) {
    if (isChatCanvasNode(node)) {
      ownership.push({
        kind: 'chat',
        id: node.id,
        projectId: node.data.projectId,
        worktreeId: node.data.worktreeId,
        role: node.data.role,
        orchestratedBy: node.data.orchestratedBy
      })
    } else if (isWorktreeCanvasNode(node)) {
      ownership.push({ kind: 'worktree', worktreeId: node.data.worktreeId, projectId: node.data.projectId })
    }
  }
  return sharedTicketWorktreeOwners(ownership)
}

/**
 * Per-project summaries. Worktrees spawned for an orchestrator's ticket sessions are nested under
 * that orchestrator's session row (`ticketWorktrees`) instead of listed beside every other
 * worktree; everything else is listed exactly as before. Counts do not change: a nested row is
 * still a node of its project.
 */
export function projectSidebarSummaries(
  nodes: readonly CanvasNode[],
  statuses: Readonly<Record<string, TerminalNodeStatus>>
): ReadonlyMap<string, SidebarProjectSummary> {
  const summaries = new Map<string, SidebarProjectSummary>()
  const summaryOf = (projectId: string): SidebarProjectSummary => {
    const existing = summaries.get(projectId)
    if (existing) return existing
    const created: SidebarProjectSummary = { sessions: [], worktrees: [], nodeCount: 0, sessionNodeIds: [] }
    summaries.set(projectId, created)
    return created
  }
  // Worktrees first, so a session finds the worktree it is attached to whatever the node order.
  const worktreeRows = new Map<string, SidebarWorktreeRow>()
  for (const node of nodes) {
    if (!isWorktreeCanvasNode(node)) continue
    const summary = summaryOf(node.data.projectId)
    const row: SidebarWorktreeRow = {
      id: node.id,
      branch: node.data.branch,
      path: node.data.path,
      selected: node.selected ?? false,
      collapsed: node.data.collapsed === true,
      attachedNodeCount: node.data.attachedNodeCount,
      sessions: []
    }
    summary.worktrees.push(row)
    worktreeRows.set(node.data.worktreeId, row)
    summary.nodeCount += 1
  }
  const sessionRows = new Map<string, SidebarSessionRow>()
  for (const node of nodes) {
    if (!isTerminalCanvasNode(node)) continue
    const summary = summaryOf(node.data.projectId)
    const row: SidebarSessionRow = {
      id: node.id,
      label: node.data.label,
      kind: node.data.kind,
      orchestrator: node.data.role === ORCHESTRATOR_ROLE,
      selected: node.selected ?? false,
      status: sessionNodeStatus(node, statuses),
      terminalLiveness: node.data.kind === 'terminal' ? node.data.terminalLiveness : undefined,
      ticketWorktrees: []
    }
    sessionRows.set(node.id, row)
    const list = (node.data.worktreeId && worktreeRows.get(node.data.worktreeId)) || summary
    list.sessions.push(row)
    summary.sessionNodeIds.push(node.id)
    summary.nodeCount += 1
  }
  // In canvas order, so an orchestrator lists its worktrees the way the top level would.
  const owners = ticketWorktreeOwners(nodes)
  const nested = new Set<SidebarWorktreeRow>()
  for (const [worktreeId, row] of worktreeRows) {
    const ownerId = owners.get(worktreeId)
    const orchestrator = ownerId === undefined ? undefined : sessionRows.get(ownerId)
    if (!orchestrator) continue
    orchestrator.ticketWorktrees.push(row)
    nested.add(row)
  }
  for (const summary of summaries.values()) summary.worktrees = summary.worktrees.filter((row) => !nested.has(row))
  return summaries
}

/**
 * The projection the project sidebar renders: per-project summaries of the canvas, derived once
 * per render from the nodes and their live statuses. The sidebar itself never sees a canvas node -
 * it reads rows - which is what keeps `ProjectSidebar` mountable without React Flow.
 */
import type { TerminalKind, TerminalLiveness } from '../../shared/terminal'
import {
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
  selected: boolean
  status: TerminalNodeStatus
  terminalLiveness: TerminalLiveness | undefined
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
  for (const node of nodes) {
    if (!isTerminalCanvasNode(node)) continue
    const summary = summaryOf(node.data.projectId)
    const row: SidebarSessionRow = {
      id: node.id,
      label: node.data.label,
      kind: node.data.kind,
      selected: node.selected ?? false,
      status: sessionNodeStatus(node, statuses),
      terminalLiveness: node.data.kind === 'terminal' ? node.data.terminalLiveness : undefined
    }
    const list = (node.data.worktreeId && worktreeRows.get(node.data.worktreeId)) || summary
    list.sessions.push(row)
    summary.sessionNodeIds.push(node.id)
    summary.nodeCount += 1
  }
  return summaries
}

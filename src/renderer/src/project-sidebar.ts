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
  attachedNodeCount: number
}

export interface SidebarProjectSummary {
  sessions: SidebarSessionRow[]
  worktrees: SidebarWorktreeRow[]
  /** Sessions plus worktrees - what the locate button counts and the remove button guards on. */
  nodeCount: number
  /** The session node ids, for counting and describing this project's unread records. */
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
  for (const node of nodes) {
    if (isTerminalCanvasNode(node)) {
      const summary = summaryOf(node.data.projectId)
      summary.sessions.push({
        id: node.id,
        label: node.data.label,
        kind: node.data.kind,
        selected: node.selected ?? false,
        status: sessionNodeStatus(node, statuses),
        terminalLiveness: node.data.kind === 'terminal' ? node.data.terminalLiveness : undefined
      })
      summary.sessionNodeIds.push(node.id)
      summary.nodeCount += 1
    } else if (isWorktreeCanvasNode(node)) {
      const summary = summaryOf(node.data.projectId)
      summary.worktrees.push({
        id: node.id,
        branch: node.data.branch,
        path: node.data.path,
        selected: node.selected ?? false,
        attachedNodeCount: node.data.attachedNodeCount
      })
      summary.nodeCount += 1
    }
  }
  return summaries
}

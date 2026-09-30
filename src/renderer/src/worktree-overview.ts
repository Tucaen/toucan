import {
  compareAttentionKinds,
  describeUnreadAttention,
  dominantUnreadKind,
  unreadAttentionByNode,
  type AttentionKind,
  type AttentionState
} from '../../shared/attention'
import type { TerminalNodeStatus } from '../../shared/terminal'
import { isTerminalCanvasNode, isWorktreeCanvasNode, sessionNodeStatus, type CanvasNode } from './canvas-workspace'
import type { WorktreeCanvasPartition } from './worktree-canvas'

/** One chat in a worktree that has unread attention records - the place the user has to go. */
export interface WorktreeChatAttention {
  nodeId: string
  label: string
  /** The most blocking unread kind on the chat; see `dominantUnreadKind`. */
  kind: AttentionKind
  /** Every unread record on the chat, so the counts add up to what the sidebar and header count. */
  count: number
  /** The chat and its own breakdown, for a tooltip: "Chat 2: 1 approval · 1 failure". */
  description: string
}

/**
 * What a worktree's header says about its agents. Agent state only: git
 * state is the header's own poll, and deliberately not folded in here - a clean checkout says
 * nothing about whether a turn is finished.
 */
export interface WorktreeSummary {
  worktreeId: string
  /** The worktree node's id, which is what focusing the worktree itself addresses. */
  nodeId: string
  branch: string
  /** The first chat's conversation title, once it has one: what the worktree is being used for. */
  task?: string
  projectName: string
  projectColor: string
  collapsed: boolean
  /** Chats mid-turn; a stalled turn is still one the agent has not finished. */
  working: number
  /** In chat order, never re-sorted by urgency, so an entry does not move under the pointer. */
  attention: WorktreeChatAttention[]
  /** Every unread record across its chats. */
  unread: number
  /** The chat to go to first: the most blocking kind, and the earliest chat among equals. */
  urgent?: WorktreeChatAttention
}

/**
 * Every worktree on the canvas, in canvas order, summarized from the same two sources every other
 * surface reads: the session statuses and the durable attention records.
 */
export function summarizeWorktrees(
  nodes: readonly CanvasNode[],
  partition: WorktreeCanvasPartition,
  statuses: Readonly<Record<string, TerminalNodeStatus>>,
  records: AttentionState
): WorktreeSummary[] {
  const unreadByNode = unreadAttentionByNode(records)
  return nodes.filter(isWorktreeCanvasNode).map((node) => {
    // Sessions only: a file or diff review shown on the same canvas has no agent state to report.
    const children = (partition.children.get(node.data.worktreeId) ?? []).filter(isTerminalCanvasNode)
    const attention: WorktreeChatAttention[] = []
    let working = 0
    let unread = 0
    let urgent: WorktreeChatAttention | undefined
    for (const child of children) {
      const status = sessionNodeStatus(child, statuses)
      if (status === 'working' || status === 'stalled') working += 1
      const count = unreadByNode[child.id] ?? 0
      const kind = count > 0 ? dominantUnreadKind(records, child.id) : undefined
      if (!kind) continue
      const item: WorktreeChatAttention = {
        nodeId: child.id,
        label: child.data.label,
        kind,
        count,
        description: `${child.data.label}: ${describeUnreadAttention(records, [child.id])}`
      }
      attention.push(item)
      unread += count
      if (!urgent || compareAttentionKinds(kind, urgent.kind) < 0) urgent = item
    }
    const titled = children.find((child) => child.data.titleSource !== undefined)
    return {
      worktreeId: node.data.worktreeId,
      nodeId: node.id,
      branch: node.data.branch,
      ...(titled ? { task: titled.data.label } : {}),
      projectName: node.data.projectName,
      projectColor: node.data.projectColor,
      collapsed: node.data.collapsed === true,
      working,
      attention,
      unread,
      ...(urgent ? { urgent } : {})
    }
  })
}

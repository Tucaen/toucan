import {
  compareAttentionKinds,
  describeUnreadAttention,
  dominantUnreadKind,
  unreadAttentionByNode,
  type AttentionKind,
  type AttentionState
} from '../../shared/attention'
import type { TerminalNodeStatus } from '../../shared/terminal'
import { isWorktreeCanvasNode, sessionNodeStatus, type CanvasNode } from './canvas-workspace'
import type { WorktreeCanvasPartition } from './worktree-canvas'

/** One chat in a worktree that has unread attention records - the place the user has to go. */
export interface WorktreeChatAttention {
  nodeId: string
  label: string
  /** The most blocking unread kind on the chat; see `dominantUnreadKind`. */
  kind: AttentionKind
  /** Every unread record on the chat, so the counts add up to what the sidebar and header count. */
  count: number
  /** The chat's own breakdown, for a tooltip. */
  description: string
}

/**
 * What a worktree's header and the worktree navigator both say about it. Agent state only: git
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
  unavailable: boolean
  chats: number
  /** Chats mid-turn; a stalled turn is still one the agent has not finished. */
  working: number
  /** In chat order, never re-sorted by urgency, so an entry does not move under the pointer. */
  attention: WorktreeChatAttention[]
}

export function worktreeAttentionTotal(summary: WorktreeSummary): number {
  return summary.attention.reduce((total, item) => total + item.count, 0)
}

/** The chat to go to first: the most blocking kind, and the earliest chat among equals. */
export function mostUrgentAttention(summary: WorktreeSummary): WorktreeChatAttention | undefined {
  let best: WorktreeChatAttention | undefined
  for (const item of summary.attention) {
    if (!best || compareAttentionKinds(item.kind, best.kind) < 0) best = item
  }
  return best
}

/**
 * Every worktree on the canvas, in canvas order, summarized from the same two sources every other
 * surface reads: the session statuses and the durable attention records. Header and navigator are
 * handed the same objects, so their counts cannot disagree.
 */
export function summarizeWorktrees(
  nodes: readonly CanvasNode[],
  partition: WorktreeCanvasPartition,
  statuses: Readonly<Record<string, TerminalNodeStatus>>,
  records: AttentionState
): WorktreeSummary[] {
  const unread = unreadAttentionByNode(records)
  return nodes.filter(isWorktreeCanvasNode).map((node) => {
    const children = partition.children.get(node.data.worktreeId) ?? []
    const attention: WorktreeChatAttention[] = []
    let working = 0
    for (const child of children) {
      const status = sessionNodeStatus(child, statuses)
      if (status === 'working' || status === 'stalled') working += 1
      const count = unread[child.id] ?? 0
      const kind = count > 0 ? dominantUnreadKind(records, child.id) : undefined
      if (kind) {
        attention.push({
          nodeId: child.id,
          label: child.data.label,
          kind,
          count,
          description: describeUnreadAttention(records, [child.id])
        })
      }
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
      unavailable: node.data.unavailable === true,
      chats: children.length,
      working,
      attention
    }
  })
}

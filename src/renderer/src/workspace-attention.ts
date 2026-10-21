import { useCallback, useEffect, useMemo, useState, type Dispatch, type SetStateAction } from 'react'
import {
  applyAttentionAction,
  countUnreadAttention,
  describeUnreadAttention,
  dominantUnreadKind,
  forgetAttention,
  pruneAttention,
  unreadAttentionByNode,
  type AttentionKind,
  type AttentionState
} from '../../shared/attention'
import { isTerminalCanvasNode, type CanvasNode, type NodeAttentionAction } from './canvas-workspace'
import { ticketWorktreeOwners } from './project-sidebar'

/** What an orchestrator can resolve itself; only the kinds it cannot (approval, sign-in) stay with the user. */
const ORCHESTRATOR_HANDLED_KINDS: readonly AttentionKind[] = ['result', 'failure', 'output']

/**
 * The records the user is asked to act on. Nodes in a worktree an orchestrator owns (see
 * `ticketWorktreeOwners`) report finished turns, failures and output to that orchestrator, so those
 * kinds are dropped here; approvals and sign-ins still need the user. This is a projection only:
 * the durable records are untouched, so restored attention follows the same rule and ownership
 * changes take effect immediately.
 * @internal exported for tests
 */
export function userVisibleAttention(records: AttentionState, nodes: readonly CanvasNode[]): AttentionState {
  if (records.length === 0) return records
  const owners = ticketWorktreeOwners(nodes)
  if (owners.size === 0) return records
  const handled = new Set<string>()
  for (const node of nodes) {
    if (node.data.worktreeId && owners.has(node.data.worktreeId)) handled.add(node.id)
  }
  const visible = records.filter(
    (item) => !(handled.has(item.nodeId) && ORCHESTRATOR_HANDLED_KINDS.includes(item.kind))
  )
  return visible.length === records.length ? records : visible
}

interface WorkspaceAttention {
  /** Every durable record, hidden kinds included: this is what the workspace persists. */
  records: AttentionState
  /** What the user is asked to act on (`userVisibleAttention`): the source of every count and summary. */
  visibleRecords: AttentionState
  unreadByNode: Record<string, number>
  unreadTotal: number
  count(nodeIds?: readonly string[]): number
  describe(nodeIds?: readonly string[]): string
  report(action: NodeAttentionAction): void
  forget(nodeIds: ReadonlySet<string>): void
  restore(records: AttentionState, liveNodeIds: readonly string[]): void
}

/** Owns durable attention transitions and keeps their canvas-node projection consistent. */
export function useWorkspaceAttention(
  nodes: readonly CanvasNode[],
  setNodes: Dispatch<SetStateAction<CanvasNode[]>>
): WorkspaceAttention {
  const [records, setRecords] = useState<AttentionState>([])
  // Every count and projection below reads the user-visible set; only persistence reads `records`.
  const visibleRecords = useMemo(() => userVisibleAttention(records, nodes), [records, nodes])

  const report = useCallback((action: NodeAttentionAction): void => {
    const at = Date.now()
    setRecords((current) => applyAttentionAction(current, action, at))
  }, [])

  const forget = useCallback((nodeIds: ReadonlySet<string>): void => {
    setRecords((current) => forgetAttention(current, nodeIds))
  }, [])

  const restore = useCallback((saved: AttentionState, liveNodeIds: readonly string[]): void => {
    setRecords(pruneAttention(saved, liveNodeIds))
  }, [])

  const unreadByNode = useMemo(() => unreadAttentionByNode(visibleRecords), [visibleRecords])
  const unreadTotal = useMemo(() => countUnreadAttention(visibleRecords), [visibleRecords])
  const count = useCallback(
    (nodeIds?: readonly string[]): number => countUnreadAttention(visibleRecords, nodeIds),
    [visibleRecords]
  )
  const describe = useCallback(
    (nodeIds?: readonly string[]): string => describeUnreadAttention(visibleRecords, nodeIds),
    [visibleRecords]
  )

  useEffect(() => {
    setNodes((current) => {
      let changed = false
      const next = current.map((node) => {
        if (!isTerminalCanvasNode(node)) return node
        const unread = unreadByNode[node.id] ?? 0
        const unreadKind = dominantUnreadKind(visibleRecords, node.id)
        if ((node.data.unread ?? 0) === unread && node.data.unreadKind === unreadKind) return node
        changed = true
        return { ...node, data: { ...node.data, unread, unreadKind } }
      })
      return changed ? next : current
    })
  }, [visibleRecords, setNodes, unreadByNode])

  return { records, visibleRecords, unreadByNode, unreadTotal, count, describe, report, forget, restore }
}

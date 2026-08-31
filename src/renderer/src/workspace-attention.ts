import { useCallback, useEffect, useMemo, useState, type Dispatch, type SetStateAction } from 'react'
import {
  applyAttentionAction,
  countUnreadAttention,
  describeUnreadAttention,
  dominantUnreadKind,
  forgetAttention,
  pruneAttention,
  unreadAttentionByNode,
  type AttentionState
} from '../../shared/attention'
import { isTerminalCanvasNode, type CanvasNode, type NodeAttentionAction } from './canvas-workspace'

interface WorkspaceAttention {
  records: AttentionState
  unreadByNode: Record<string, number>
  unreadTotal: number
  count(nodeIds?: readonly string[]): number
  describe(nodeIds?: readonly string[]): string
  report(action: NodeAttentionAction): void
  forget(nodeIds: ReadonlySet<string>): void
  restore(records: AttentionState, liveNodeIds: readonly string[]): void
}

/** Owns durable attention transitions and keeps their canvas-node projection consistent. */
export function useWorkspaceAttention(setNodes: Dispatch<SetStateAction<CanvasNode[]>>): WorkspaceAttention {
  const [records, setRecords] = useState<AttentionState>([])

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

  const unreadByNode = useMemo(() => unreadAttentionByNode(records), [records])
  const unreadTotal = useMemo(() => countUnreadAttention(records), [records])
  const count = useCallback((nodeIds?: readonly string[]): number => countUnreadAttention(records, nodeIds), [records])
  const describe = useCallback(
    (nodeIds?: readonly string[]): string => describeUnreadAttention(records, nodeIds),
    [records]
  )

  useEffect(() => {
    setNodes((current) => {
      let changed = false
      const next = current.map((node) => {
        if (!isTerminalCanvasNode(node)) return node
        const unread = unreadByNode[node.id] ?? 0
        const unreadKind = dominantUnreadKind(records, node.id)
        if ((node.data.unread ?? 0) === unread && node.data.unreadKind === unreadKind) return node
        changed = true
        return { ...node, data: { ...node.data, unread, unreadKind } }
      })
      return changed ? next : current
    })
  }, [records, setNodes, unreadByNode])

  return { records, unreadByNode, unreadTotal, count, describe, report, forget, restore }
}

import type { AgentProvider } from '../../shared/agent-provider'
import type { ConversationLineage } from '../../shared/workspace'
import { isChatCanvasNode, type CanvasNode } from './canvas-workspace'

/**
 * What opening a History entry does, decided before any node is placed.
 *
 * A conversation has one writer. Codex refuses a second `thread/resume` of a thread that already
 * has one (surfacing as a bare "Internal error"), and Claude would take it and interleave two
 * writers in one transcript - so an entry that is already open on the canvas is *focused*, never
 * opened again (#240).
 */
export type HistoryOpenPlan =
  | { action: 'focus'; nodeId: string }
  /**
   * `branchedFrom` is present when the entry is a fork whose parent is on the canvas, so the
   * reopened node carries its provenance and draws its lineage edge again.
   */
  | { action: 'open'; branchedFrom?: ConversationLineage }

/** The little of an entry this decision reads; a brain-dump capture reopens through it too. */
export interface HistoryOpenEntry {
  provider: AgentProvider
  id: string
  /** The conversation the entry was forked from, when that is known. */
  forkedFrom?: string
}

/** The chat node that holds this provider conversation, if one is on the canvas. */
function nodeHoldingConversation(
  nodes: readonly CanvasNode[],
  provider: AgentProvider,
  conversationId: string
): CanvasNode | undefined {
  return nodes.find(
    (node) => isChatCanvasNode(node) && node.data.kind === provider && node.data.conversationId === conversationId
  )
}

export function planHistoryOpen(nodes: readonly CanvasNode[], entry: HistoryOpenEntry): HistoryOpenPlan {
  const holder = nodeHoldingConversation(nodes, entry.provider, entry.id)
  if (holder) return { action: 'focus', nodeId: holder.id }
  const parent = entry.forkedFrom ? nodeHoldingConversation(nodes, entry.provider, entry.forkedFrom) : undefined
  return parent && entry.forkedFrom
    ? { action: 'open', branchedFrom: { nodeId: parent.id, conversationId: entry.forkedFrom } }
    : { action: 'open' }
}

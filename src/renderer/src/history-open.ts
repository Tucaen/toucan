import type { TerminalKind } from '../../shared/terminal'
import { isChatCanvasNode, type CanvasNode } from './canvas-workspace'

/**
 * What opening a History entry does, decided before any node is placed.
 *
 * A conversation has one writer. Codex refuses a second `thread/resume` of a thread that already
 * has one (surfacing as a bare "Internal error"), and Claude would take it and interleave two
 * writers in one transcript - so an entry that is already open on the canvas is *focused*, never
 * opened again (#240).
 */
export type HistoryOpenPlan = { action: 'focus'; nodeId: string } | { action: 'open' }

/** The little of an entry this decision reads; a brain-dump capture reopens through it too. */
export interface HistoryOpenEntry {
  provider: TerminalKind
  id: string
}

/** The chat node that holds this provider conversation, if one is on the canvas. */
export function nodeHoldingConversation(
  nodes: readonly CanvasNode[],
  provider: TerminalKind,
  conversationId: string
): CanvasNode | undefined {
  return nodes.find(
    (node) => isChatCanvasNode(node) && node.data.kind === provider && node.data.conversationId === conversationId
  )
}

export function planHistoryOpen(nodes: readonly CanvasNode[], entry: HistoryOpenEntry): HistoryOpenPlan {
  const holder = nodeHoldingConversation(nodes, entry.provider, entry.id)
  return holder ? { action: 'focus', nodeId: holder.id } : { action: 'open' }
}

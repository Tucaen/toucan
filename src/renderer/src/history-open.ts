import type { AgentProvider } from '../../shared/agent-provider'
import {
  isChatNodeRole,
  sameOrchestration,
  type ChatNodeRole,
  type OrchestrationConversation
} from '../../shared/orchestration'
import { orchestratorProvider } from '../../shared/ticket-session-spawn'
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
   * reopened node carries its provenance and draws its lineage edge again. `role` is present when
   * the conversation is an orchestrator's, so it reopens as one - minted its token, given its
   * controls - rather than as a plain chat holding an orchestrator's transcript (Tucaen/toucan#1).
   */
  | { action: 'open'; branchedFrom?: ConversationLineage; role?: ChatNodeRole }

/** The little of an entry this decision reads. */
export interface HistoryOpenEntry {
  provider: AgentProvider
  id: string
  /** The conversation the entry was forked from, when that is known. */
  forkedFrom?: string
  /** The role main says the conversation's chat had. */
  role?: ChatNodeRole
}

/** The chat node that holds this provider conversation, if one is on the canvas. */
export function nodeHoldingConversation(
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
  return {
    action: 'open',
    ...(parent && entry.forkedFrom ? { branchedFrom: { nodeId: parent.id, conversationId: entry.forkedFrom } } : {}),
    ...(isChatNodeRole(entry.role) ? { role: entry.role } : {})
  }
}

/**
 * Points the ticket sessions of a reopened orchestrator at its new node. They still name the node
 * that was closed, and that link is what draws their orchestrated-by edge and what main reads to
 * address their wakes; the orchestration itself is the conversation, so a link matches on that.
 * Every other node comes back as the same object.
 */
export function relinkTicketSessions(
  nodes: readonly CanvasNode[],
  orchestration: OrchestrationConversation,
  nodeId: string
): CanvasNode[] {
  return nodes.map((node) => {
    if (!isChatCanvasNode(node)) return node
    const link = node.data.orchestratedBy
    if (
      !link ||
      link.nodeId === nodeId ||
      !sameOrchestration({ provider: orchestratorProvider(link), conversationId: link.conversationId }, orchestration)
    )
      return node
    return { ...node, data: { ...node.data, orchestratedBy: { ...link, nodeId } } }
  })
}

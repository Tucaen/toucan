import type { TicketCleanupRequest, TicketCleanupResult } from '../../shared/orchestration-cleanup'
import { pathIdentity } from '../../shared/paths'
import type { TerminalNodeStatus } from '../../shared/terminal'
import { isFileCanvasNode, isTerminalCanvasNode, isWorktreeCanvasNode, type CanvasNode } from './canvas-workspace'

/** Cleanup retires its settled chat first. Other sessions and file editors only block worktree removal. */
export function ticketCleanupNodes(
  request: TicketCleanupRequest,
  nodes: readonly CanvasNode[],
  statuses: Readonly<Record<string, TerminalNodeStatus>>
): TicketCleanupResult & { removeIds?: string[]; suspendId?: string } {
  const { session } = request
  const worktree = nodes
    .filter(isWorktreeCanvasNode)
    .find((node) => pathIdentity(node.data.path) === pathIdentity(session.worktreePath))
  const ticket = nodes.find((node) => node.id === session.nodeId)
  if (!worktree) {
    return ticket
      ? { ok: false, message: 'The ticket chat moved away from its worktree.' }
      : { ok: true, removeIds: [] }
  }
  if (
    pathIdentity(worktree.data.projectPath) !== pathIdentity(request.projectPath) ||
    worktree.data.branch !== session.branch
  ) {
    return { ok: false, message: 'The canvas worktree identity changed.' }
  }
  if (ticket) {
    if (
      !isTerminalCanvasNode(ticket) ||
      ticket.data.conversationId !== session.conversationId ||
      ticket.data.worktreeId !== worktree.data.worktreeId
    ) {
      return { ok: false, message: 'The ticket chat identity changed.' }
    }
    if (request.phase === 'retire') {
      const status = ticket.data.dormant ? 'dormant' : statuses[ticket.id]
      if (!status || !['idle', 'result', 'dormant', 'exited'].includes(status)) {
        return { ok: false, message: 'The ticket session is busy or waiting for an answer.' }
      }
    }
  }
  if (request.phase === 'retire') return { ok: true, suspendId: ticket?.id }

  const children = nodes.filter((node) => node.data.worktreeId === worktree.data.worktreeId && node.id !== worktree.id)
  if (children.some((node) => isFileCanvasNode(node) || (isTerminalCanvasNode(node) && node.id !== session.nodeId))) {
    return { ok: false, message: 'Another session or file editor is using the ticket worktree.' }
  }
  return {
    ok: true,
    ...(request.phase === 'remove' ? { removeIds: [worktree.id, ...children.map((node) => node.id)] } : {})
  }
}

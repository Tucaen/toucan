import type { TicketCleanupRequest, TicketCleanupResult } from '../../shared/orchestration-cleanup'
import { pathIdentity } from '../../shared/paths'
import type { TerminalNodeStatus } from '../../shared/terminal'
import { isFileCanvasNode, isTerminalCanvasNode, isWorktreeCanvasNode, type CanvasNode } from './canvas-workspace'

/** Cleanup suspends its own settled chat until Git succeeds. Other sessions and file editors keep the worktree. */
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
  const children = nodes.filter((node) => node.data.worktreeId === worktree.data.worktreeId && node.id !== worktree.id)
  if (children.some((node) => isFileCanvasNode(node) || (isTerminalCanvasNode(node) && node.id !== session.nodeId))) {
    return { ok: false, message: 'Another session or file editor is using the ticket worktree.' }
  }
  if (ticket) {
    if (
      !isTerminalCanvasNode(ticket) ||
      ticket.data.conversationId !== session.conversationId ||
      ticket.data.worktreeId !== worktree.data.worktreeId
    ) {
      return { ok: false, message: 'The ticket chat identity changed.' }
    }
    const status = ticket.data.dormant ? 'dormant' : statuses[ticket.id]
    if (!status || !['idle', 'result', 'dormant', 'exited'].includes(status)) {
      return { ok: false, message: 'The ticket session is busy or waiting for an answer.' }
    }
  }
  return {
    ok: true,
    ...(request.phase === 'close'
      ? { suspendId: ticket?.id }
      : { removeIds: [worktree.id, ...children.map((node) => node.id)] })
  }
}

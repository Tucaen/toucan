import { useEffect, useRef } from 'react'
import { spawnSettlement } from '../../shared/remote-spawn'
import type { TerminalNodeStatus } from '../../shared/terminal'
import type { TicketSessionCanvasRequest, TicketSessionCanvasResult } from '../../shared/ticket-session-spawn'
import { isTerminalCanvasNode, type CanvasNode } from './canvas-workspace'

/** What the canvas's start step answers: the node it added, or why it added none. */
export type TicketSessionStart = { ok: true; nodeId: string } | { ok: false; message: string }

/** What this hook does to the canvas. */
export interface TicketSessionCanvas {
  start(request: TicketSessionCanvasRequest): TicketSessionStart
  /** Takes the node off the canvas, which stops its session. */
  close(nodeId: string): void
  /** Withdraws the ticket prompt a node has not sent yet, leaving the node and its error in place. */
  dropPrompt(nodeId: string): void
}

const START_FAILED_MESSAGE = 'The ticket session could not be started on the desktop.'

/**
 * Answers main's ticket-session requests (#34). Like a phone's spawn (`use-remote-access.ts`) the
 * verdict is never optimistic: the orchestrator records the session against its ticket, so a node
 * is reported only once its session has settled by `spawnSettlement`, and with the conversation id
 * the node carries - the one its transcript and outcome record are keyed by. Before that main is
 * told the node exists (and later its conversation id), so a session that is slow to come up is
 * linked to its ticket from the start and its verdict still reaches main after main stopped
 * waiting (#1).
 *
 * Unlike a phone's, a failure is made true (#1): the orchestrator retries it, and a node that
 * still carried the ticket would hand it to a session nobody tracks - after a sign-in or a resume
 * here. So a failure verdict drops the node's prompt (and closes a node whose session is running
 * all the same), and a node main cancels is closed whatever state it reached.
 */
export function useTicketSessionSpawns(
  canvas: TicketSessionCanvas,
  nodes: readonly CanvasNode[],
  statuses: Readonly<Record<string, TerminalNodeStatus>>
): void {
  // Requests whose node is on the canvas but whose session has not reported yet, by request id.
  const awaiting = useRef(new Map<string, string>())
  // The conversation id main was last told of for each of them, so it hears of it once.
  const reported = useRef(new Map<string, string | undefined>())
  const canvasRef = useRef(canvas)
  canvasRef.current = canvas
  // Pair requests with the render that can see their nodes. A request arriving after render
  // must not be failed by that render's pending effect, whose nodes predate the spawn.
  const pending = [...awaiting.current]

  useEffect(() => {
    const stopStarting = window.orchestratorApi.onStartTicketSession((requestId, request) => {
      const result = canvasRef.current.start(request)
      if (!result.ok) {
        window.orchestratorApi.completeTicketSession(requestId, result)
        return
      }
      awaiting.current.set(requestId, result.nodeId)
      reported.current.set(requestId, undefined)
      window.orchestratorApi.progressTicketSession(requestId, { nodeId: result.nodeId })
    })
    const stopWithdrawing = window.orchestratorApi.onCancelTicketSession((nodeId) => {
      for (const [requestId, awaitedNode] of [...awaiting.current]) {
        if (awaitedNode !== nodeId) continue
        awaiting.current.delete(requestId)
        reported.current.delete(requestId)
      }
      canvasRef.current.close(nodeId)
    })
    return () => {
      stopStarting()
      stopWithdrawing()
    }
  }, [])

  useEffect(() => {
    for (const [requestId, nodeId] of pending) {
      if (!awaiting.current.has(requestId)) continue
      const node = nodes.find((candidate) => candidate.id === nodeId)
      // Closed before it came up: nothing will report on it again, so main is answered now.
      const settlement = node ? spawnSettlement(statuses[nodeId] ?? 'starting') : 'failed'
      const conversationId = node && isTerminalCanvasNode(node) ? node.data.conversationId : undefined
      if (settlement === 'pending') {
        if (conversationId && reported.current.get(requestId) !== conversationId) {
          reported.current.set(requestId, conversationId)
          window.orchestratorApi.progressTicketSession(requestId, { nodeId, conversationId })
        }
        continue
      }
      awaiting.current.delete(requestId)
      reported.current.delete(requestId)
      const result: TicketSessionCanvasResult =
        settlement === 'started' && conversationId
          ? { ok: true, nodeId, conversationId }
          : { ok: false, message: START_FAILED_MESSAGE }
      if (!result.ok && node) {
        canvasRef.current.dropPrompt(nodeId)
        // A session that is up but cannot be tracked is not left working the ticket.
        if (settlement === 'started') canvasRef.current.close(nodeId)
      }
      window.orchestratorApi.completeTicketSession(requestId, result)
    }
  })
}

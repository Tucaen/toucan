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
 * the node carries - the one its transcript and outcome record are keyed by.
 *
 * Unlike a phone's, a failure is made true (#1): the orchestrator retries it, and a node that
 * still carried the ticket would hand it to a session nobody tracks - after a sign-in or a resume
 * here, or simply by coming up late when main stopped waiting. So a failure verdict drops the
 * node's prompt, and a request main withdraws closes its node whatever state it reached.
 */
export function useTicketSessionSpawns(
  canvas: TicketSessionCanvas,
  nodes: readonly CanvasNode[],
  statuses: Readonly<Record<string, TerminalNodeStatus>>
): void {
  // Requests whose node is on the canvas but whose session has not reported yet, by request id.
  const awaiting = useRef(new Map<string, string>())
  // Every node this window started, settled or not: a withdrawal can cross the verdict in flight,
  // which main ignores. One entry per spawn, bounded by the spawn budget and gone on reload.
  const started = useRef(new Map<string, string>())
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
      started.current.set(requestId, result.nodeId)
    })
    const stopWithdrawing = window.orchestratorApi.onCancelTicketSession((requestId) => {
      const nodeId = started.current.get(requestId)
      awaiting.current.delete(requestId)
      started.current.delete(requestId)
      if (nodeId) canvasRef.current.close(nodeId)
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
      if (settlement === 'pending') continue
      awaiting.current.delete(requestId)
      const conversationId = node && isTerminalCanvasNode(node) ? node.data.conversationId : undefined
      const result: TicketSessionCanvasResult =
        settlement === 'started' && conversationId
          ? { ok: true, nodeId, conversationId }
          : { ok: false, message: START_FAILED_MESSAGE }
      if (!result.ok && node) canvasRef.current.dropPrompt(nodeId)
      window.orchestratorApi.completeTicketSession(requestId, result)
    }
  })
}

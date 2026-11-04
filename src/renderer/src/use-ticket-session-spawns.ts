import { useEffect, useRef } from 'react'
import { spawnSettlement } from '../../shared/remote-spawn'
import type { TerminalNodeStatus } from '../../shared/terminal'
import type { TicketSessionCanvasRequest, TicketSessionCanvasResult } from '../../shared/ticket-session-spawn'
import { isTerminalCanvasNode, type CanvasNode } from './canvas-workspace'

/** What the canvas's start step answers: the node it added, or why it added none. */
export type TicketSessionStart = { ok: true; nodeId: string } | { ok: false; message: string }

const START_FAILED_MESSAGE = 'The ticket session could not be started on the desktop.'

/**
 * Answers main's ticket-session requests (#34). Like a phone's spawn (`use-remote-access.ts`) the
 * verdict is never optimistic: the orchestrator records the session against its ticket, so a node
 * is reported only once its session has settled by `spawnSettlement`, and with the conversation id
 * the node carries - the one its transcript and outcome record are keyed by.
 *
 * Unlike a phone's, a request main stops waiting for is withdrawn (#1): the orchestrator was told
 * the spawn failed and retries it, so `close` takes the node off the canvas - which stops its
 * session - before it can come up and work the ticket unseen beside the retry.
 */
export function useTicketSessionSpawns(
  start: (request: TicketSessionCanvasRequest) => TicketSessionStart,
  close: (nodeId: string) => void,
  nodes: readonly CanvasNode[],
  statuses: Readonly<Record<string, TerminalNodeStatus>>
): void {
  // Requests whose node is on the canvas but whose session has not reported yet, by request id.
  const awaiting = useRef(new Map<string, string>())
  // Every node this window started, settled or not: a withdrawal can cross its verdict in flight,
  // and main, having answered the spawn already, ignores that verdict.
  const started = useRef(new Map<string, string>())
  const starter = useRef(start)
  starter.current = start
  const closer = useRef(close)
  closer.current = close
  // Pair requests with the render that can see their nodes. A request arriving after render
  // must not be failed by that render's pending effect, whose nodes predate the spawn.
  const pending = [...awaiting.current]

  useEffect(() => {
    const stopStarting = window.orchestratorApi.onStartTicketSession((requestId, request) => {
      const result = starter.current(request)
      if (!result.ok) {
        window.orchestratorApi.completeTicketSession(requestId, result)
        return
      }
      awaiting.current.set(requestId, result.nodeId)
      started.current.set(requestId, result.nodeId)
    })
    const stopCancelling = window.orchestratorApi.onCancelTicketSession((requestId) => {
      const nodeId = started.current.get(requestId)
      awaiting.current.delete(requestId)
      started.current.delete(requestId)
      if (nodeId) closer.current(nodeId)
    })
    return () => {
      stopStarting()
      stopCancelling()
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
      window.orchestratorApi.completeTicketSession(requestId, result)
    }
  })
}

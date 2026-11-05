import { ORCHESTRATOR_CHANNELS } from '../shared/ipc-channels'
import { DEFAULT_START_TIMEOUT_SECONDS } from '../shared/orchestration-routing'
import type {
  TicketSessionCanvasRequest,
  TicketSessionCanvasResult,
  TicketSessionProgress
} from '../shared/ticket-session-spawn'
import {
  createWindowRequests,
  type WindowRequestObserver,
  type WindowRequests,
  type WindowRequestsOptions
} from './window-requests'

/**
 * How long an orchestrator's `spawn` waits for the canvas to bring its ticket session up (#34) when
 * its project does not say (`startTimeoutSeconds`), counted from the last sign of life: the node
 * appearing, the session's own first output. A session normally settles in seconds, a slow setup
 * (a Windows adapter launch, an engine's first import) in minutes.
 */
const START_TIMEOUT_MS = DEFAULT_START_TIMEOUT_SECONDS * 1_000

/**
 * What a spawn that outlasted its wait reports (#1). The session is not failed and not closed: the
 * node stays linked to its ticket and Toucan wakes the orchestrator when its start settles.
 *
 * @internal exported for tests
 */
export const TICKET_SESSION_TIMEOUT_MESSAGE =
  'The ticket session is still starting. It stays linked to its ticket, and Toucan wakes you once it is up or has failed to start; do not spawn the ticket again.'

export type TicketSessionRequestsOptions = Partial<
  Pick<WindowRequestsOptions<TicketSessionCanvasResult, TicketSessionProgress>, 'timeoutMs' | 'requestId' | 'schedule'>
>

export type TicketSessionObserver = WindowRequestObserver<TicketSessionCanvasResult, TicketSessionProgress>

export interface TicketSessionRequests extends WindowRequests<
  TicketSessionCanvasRequest,
  TicketSessionCanvasResult,
  TicketSessionProgress
> {
  /**
   * The session on this node showed life (it printed something): its start is still in progress,
   * so its wait begins again. A node main has not been told of yet is none of this request's.
   */
  activity(nodeId: string): void
  /** Toucan treats this node's start as failed: the window closes it, which stops its session. */
  cancel(nodeId: string): void
}

/** The canvas half of a ticket spawn: main asks the newest live window, which answers once the session settles. */
export function createTicketSessionRequests(options: TicketSessionRequestsOptions = {}): TicketSessionRequests {
  const requests = createWindowRequests<TicketSessionCanvasRequest, TicketSessionCanvasResult, TicketSessionProgress>({
    channel: ORCHESTRATOR_CHANNELS.startTicketSession,
    messages: {
      noWindow: 'Toucan has no window open, so there is no canvas to start the ticket session on.',
      windowGone: 'The Toucan window closed before the ticket session was started.',
      timeout: TICKET_SESSION_TIMEOUT_MESSAGE
    },
    refuse: (message) => ({ ok: false, message }),
    pending: (message, progress) => ({ ok: false, pending: true, message, ...progress }),
    timeoutMs: options.timeoutMs ?? START_TIMEOUT_MS,
    requestId: options.requestId,
    schedule: options.schedule
  })
  // The request each node was reported for, forgotten with the request's answer.
  const byNode = new Map<string, string>()
  return {
    ...requests,
    progress(requestId, progress) {
      byNode.set(progress.nodeId, requestId)
      requests.progress(requestId, progress)
    },
    complete(requestId, result) {
      for (const [nodeId, id] of byNode) if (id === requestId) byNode.delete(nodeId)
      requests.complete(requestId, result)
    },
    activity(nodeId) {
      const requestId = byNode.get(nodeId)
      if (requestId) requests.touch(requestId)
    },
    cancel(nodeId) {
      requests.liveWindow()?.send(ORCHESTRATOR_CHANNELS.cancelTicketSession, nodeId)
    }
  }
}

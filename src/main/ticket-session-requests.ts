import { ORCHESTRATOR_CHANNELS } from '../shared/ipc-channels'
import type { TicketSessionCanvasRequest, TicketSessionCanvasResult } from '../shared/ticket-session-spawn'
import { createWindowRequests, type WindowRequests } from './window-requests'

/**
 * How long an orchestrator's `spawn` waits for the canvas to bring its ticket session up (#34),
 * counted from the moment the worktree is set up and the canvas is asked. A session normally
 * settles in seconds; this bounds a launch that stalls.
 */
export const TICKET_SESSION_START_TIMEOUT_MS = 90_000

/**
 * What a timed-out spawn reports. The orchestrator acts on it as a failure and retries, so it is
 * made true rather than hedged (#1): the canvas is told to close the session it started, which is
 * what keeps a late start from taking the ticket prompt and working unseen beside the retry.
 */
export const TICKET_SESSION_TIMEOUT_MESSAGE =
  'The ticket session did not finish starting in time, so Toucan closed it before it could work on the ticket.'

export interface TicketSessionRequestsOptions {
  timeoutMs?: number
  requestId?: () => string
  /** Injectable so tests do not wait in real time. */
  schedule?: (run: () => void, delayMs: number) => { cancel(): void }
}

/** The canvas half of a ticket spawn: main asks the newest live window, which answers once the session settles. */
export function createTicketSessionRequests(
  options: TicketSessionRequestsOptions = {}
): WindowRequests<TicketSessionCanvasRequest, TicketSessionCanvasResult> {
  return createWindowRequests<TicketSessionCanvasRequest, TicketSessionCanvasResult>({
    channel: ORCHESTRATOR_CHANNELS.startTicketSession,
    cancelChannel: ORCHESTRATOR_CHANNELS.cancelTicketSession,
    messages: {
      noWindow: 'Toucan has no window open, so there is no canvas to start the ticket session on.',
      windowGone: 'The Toucan window closed before the ticket session was started.',
      timeout: TICKET_SESSION_TIMEOUT_MESSAGE
    },
    refuse: (message) => ({ ok: false, message }),
    timeoutMs: options.timeoutMs ?? TICKET_SESSION_START_TIMEOUT_MS,
    requestId: options.requestId,
    schedule: options.schedule
  })
}

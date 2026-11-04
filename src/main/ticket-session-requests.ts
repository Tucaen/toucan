import { ORCHESTRATOR_CHANNELS } from '../shared/ipc-channels'
import type { TicketSessionCanvasRequest, TicketSessionCanvasResult } from '../shared/ticket-session-spawn'
import { createWindowRequests, type WindowRequests, type WindowRequestsOptions } from './window-requests'

/**
 * How long an orchestrator's `spawn` waits for the canvas to bring its ticket session up (#34),
 * counted from the moment the canvas is asked. A session normally settles in seconds.
 */
const START_TIMEOUT_MS = 90_000

/**
 * What a timed-out spawn reports (#1). The orchestrator acts on it as a failure and retries, so the
 * canvas is told to close the session rather than let it come up late and work the ticket unseen.
 *
 * @internal exported for tests
 */
export const TICKET_SESSION_TIMEOUT_MESSAGE =
  'The ticket session did not finish starting in time, so Toucan closes it rather than let it work on the ticket.'

export type TicketSessionRequestsOptions = Partial<
  Pick<WindowRequestsOptions<TicketSessionCanvasResult>, 'timeoutMs' | 'requestId' | 'schedule'>
>

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
    timeoutMs: options.timeoutMs ?? START_TIMEOUT_MS,
    requestId: options.requestId,
    schedule: options.schedule
  })
}

import type { TicketSession } from './orchestration'

/** Suspend the settled ticket chat before Git removes its directory; retire chat and frame afterwards. */
export interface TicketCleanupRequest {
  projectPath: string
  session: Required<TicketSession>
  phase: 'close' | 'remove'
}

export type TicketCleanupResult = { ok: true } | { ok: false; message: string }

import type { TicketSession } from './orchestration'

/** Retire the settled chat, preflight its canvas, then remove the chat and frame after Git succeeds. */
export interface TicketCleanupRequest {
  projectPath: string
  session: Required<TicketSession>
  phase: 'retire' | 'prepare' | 'remove'
}

export type TicketCleanupResult = { ok: true } | { ok: false; message: string }

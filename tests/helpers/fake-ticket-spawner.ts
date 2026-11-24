import type { TicketSession } from '../../src/shared/orchestration'
import type { TicketSpawnRequest, TicketSpawnResult } from '../../src/main/ticket-spawner'

/**
 * What a fake spawner answers once it decided the start succeeds: the attempt is recorded, the node
 * is reported, and `spawn` answers with its start already settled on the requested model and effort
 * (Tucaen/toucan#3). The endpoint records the run as started right after it answered; wait for
 * `endpoint.idle()` before reading that.
 */
export async function startedSpawn(
  request: TicketSpawnRequest,
  session: Required<TicketSession>,
  settings: { model?: string; effort?: string } = { model: request.model, effort: request.effort }
): Promise<TicketSpawnResult> {
  const attempt = { worktreePath: session.worktreePath, branch: session.branch }
  await request.onAttempt?.(attempt)
  await request.onSession?.(session)
  return {
    ok: true,
    attempt,
    settled: Promise.resolve({ ok: true, session, ...settings, warnings: [] }),
    cancel: () => Promise.resolve()
  }
}

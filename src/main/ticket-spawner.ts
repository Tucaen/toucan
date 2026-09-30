import type { OrchestrationTicket, TicketSession } from '../shared/orchestration'

/**
 * What the orchestrator endpoint asks for once a `spawn` is authorized and counted (#34; plan in
 * `docs/plans/orchestrator-mode.md`): one ticket session in a worktree Toucan creates for it.
 */
export interface TicketSpawnRequest {
  /** The orchestrator the session is linked to by its orchestrated-by edge. */
  orchestrator: { nodeId: string; conversationId: string }
  /** The orchestrator's project checkout; the worktree is created from it. */
  projectPath: string
  /** The branch the orchestration merges into; the ticket branch starts from it. */
  targetBranch: string
  ticket: OrchestrationTicket
  model: string
  effort: string
}

export type TicketSpawnResult =
  | {
      ok: true
      session: Required<TicketSession>
      /** The model and effort the running session reports, read back rather than assumed. */
      model?: string
      effort?: string
      /** What the caller should know but that did not stop the spawn. */
      warnings: string[]
    }
  | { ok: false; error: string }

export interface TicketSpawner {
  /** Never rejects: every failure is `{ ok: false }` with the reason the CLI prints. */
  spawn(request: TicketSpawnRequest): Promise<TicketSpawnResult>
}

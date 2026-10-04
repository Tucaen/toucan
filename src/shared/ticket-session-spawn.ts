import type { JevReachability } from './orchestration-routing'
import { isAgentProvider, type AgentProvider } from './agent-provider'
import { isRecord } from './record'
import type { TicketCleanupRequest, TicketCleanupResult } from './orchestration-cleanup'

/**
 * The canvas half of spawning a ticket session (#34). Main creates the worktree, guards it and
 * runs the project's setup command; node identity, geometry and the session launch are the
 * canvas's, so main then asks the desktop renderer to put the worktree and its chat on the canvas
 * through its own add-node path - the same split as a phone's spawn (`remote-spawn.ts`).
 */

/** Who orchestrates a ticket session: persisted on the ticket session's node, and drawn from it. */
export interface OrchestratorLink {
  nodeId: string
  conversationId: string
  /** Absent only on links saved before provider-matched ticket spawning. */
  provider?: AgentProvider
}

/** Legacy links belong to Claude, regardless of the ticket node's current provider. */
export function orchestratorProvider(link: OrchestratorLink): AgentProvider {
  return link.provider ?? 'claude'
}

export interface TicketSessionCanvasRequest {
  provider: AgentProvider
  /** The workspace project the worktree belongs to. */
  projectId: string
  /** The worktree main just created; the renderer registers it before the chat attaches to it. */
  worktree: { path: string; branch: string; baseRef: string }
  /** `#<id> <title>`, a manual title. */
  label: string
  modelId: string
  effortId: string
  /** The orchestrator's current permission mode, inherited; absent leaves the canvas default. */
  permissionMode?: string
  orchestratedBy: OrchestratorLink
  /** The first prompt: implementation skill, ticket, contract. */
  prompt: string
}

export type TicketSessionCanvasResult =
  { ok: true; nodeId: string; conversationId: string } | { ok: false; message: string }

export function isOrchestratorLink(value: unknown): value is OrchestratorLink {
  return (
    isRecord(value) &&
    typeof value.nodeId === 'string' &&
    typeof value.conversationId === 'string' &&
    (value.provider === undefined || isAgentProvider(value.provider))
  )
}

/** Narrows the renderer's answer, which crosses IPC unvalidated. */
export function isTicketSessionCanvasResult(value: unknown): value is TicketSessionCanvasResult {
  if (!isRecord(value)) return false
  if (value.ok === true) return typeof value.nodeId === 'string' && typeof value.conversationId === 'string'
  return value.ok === false && typeof value.message === 'string'
}

export interface OrchestrationControlRequest {
  provider: AgentProvider
  conversationId: string
  nodeId: string
}

export interface OrchestrationControlState {
  provider: AgentProvider
  conversationId: string
  status: 'running' | 'paused' | 'stopped'
  resetsAt?: number
}

/** The renderer's side of the request, exposed on `window.orchestratorApi`. */
export interface OrchestratorApi {
  /**
   * A ticket session main wants on the canvas. The renderer answers on `completeTicketSession`
   * once the session is up or has failed; the orchestrator's `spawn` call is waiting on it.
   */
  onStartTicketSession(callback: (requestId: string, request: TicketSessionCanvasRequest) => void): () => void
  completeTicketSession(requestId: string, result: TicketSessionCanvasResult): void
  onCleanupTicket(callback: (requestId: string, request: TicketCleanupRequest) => void): () => void
  completeCleanupTicket(requestId: string, result: TicketCleanupResult): void
  /** Whether Jev can route this orchestrator's tickets (#36); never the key itself. */
  jevReachability(): Promise<JevReachability>
  orchestrationState(request: OrchestrationControlRequest): Promise<OrchestrationControlState | null>
  resumeOrchestration(request: OrchestrationControlRequest): Promise<OrchestrationControlState | null>
  stopOrchestration(request: OrchestrationControlRequest): Promise<OrchestrationControlState | null>
  onOrchestrationState(callback: (state: OrchestrationControlState) => void): () => void
}

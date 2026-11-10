import {
  openOrchestrationQuestions,
  pacingDeferral,
  spawnBudget,
  spawnBudgetReached,
  startableTickets,
  type OrchestrationQuestion,
  type OrchestrationRecord
} from './orchestration'
import type { JevReachability } from './orchestration-routing'
import { isAgentProvider, type AgentProvider } from './agent-provider'
import { isRecord } from './record'
import type { TicketCleanupRequest, TicketCleanupResult } from './orchestration-cleanup'
import type { OrchestrationPacingReason } from './orchestration-pacing-types'

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
  /** The orchestrator's current permission mode, inherited; absent starts the provider's default (Claude's Auto). */
  permissionMode?: string
  orchestratedBy: OrchestratorLink
  /** The first prompt: implementation skill, ticket, contract. */
  prompt: string
}

/** What the canvas knows of a ticket session the moment its node exists, before it is up (#1). */
export interface TicketSessionProgress {
  nodeId: string
  /** Absent until the session has opened its conversation. */
  conversationId?: string
}

/** The renderer's verdict on a ticket session: up, or failed. */
export type TicketSessionCanvasAnswer =
  { ok: true; nodeId: string; conversationId: string } | { ok: false; message: string }

/**
 * What main learns of the start: the renderer's verdict, or `pending` - the wait ran out with the
 * session still coming up. Pending is not a failure: the node stays and its verdict arrives later.
 */
export type TicketSessionCanvasResult =
  TicketSessionCanvasAnswer | ({ ok: false; pending: true; message: string } & Partial<TicketSessionProgress>)

export function isOrchestratorLink(value: unknown): value is OrchestratorLink {
  return (
    isRecord(value) &&
    typeof value.nodeId === 'string' &&
    typeof value.conversationId === 'string' &&
    (value.provider === undefined || isAgentProvider(value.provider))
  )
}

/** Narrows the renderer's answer, which crosses IPC unvalidated. */
export function isTicketSessionCanvasResult(value: unknown): value is TicketSessionCanvasAnswer {
  if (!isRecord(value)) return false
  if (value.ok === true) return typeof value.nodeId === 'string' && typeof value.conversationId === 'string'
  // `pending` is main's own word for a wait that ran out; the renderer never says it.
  return value.ok === false && value.pending === undefined && typeof value.message === 'string'
}

export function isTicketSessionProgress(value: unknown): value is TicketSessionProgress {
  return (
    isRecord(value) &&
    typeof value.nodeId === 'string' &&
    value.nodeId.length > 0 &&
    (value.conversationId === undefined || typeof value.conversationId === 'string')
  )
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
  pacing?: {
    state: 'drain' | 'pause'
    reason: OrchestrationPacingReason
    retryAt?: number
  }
  /**
   * Present once the orchestration has used its spawn budget: it waits for the human's Continue
   * (`continueSpawns`) and refuses every spawn until then.
   */
  spawnCheckpoint?: { used: number; budget: number }
  /** Tickets the user may start now, skipping provider pacing; see `startableTickets`. */
  startable?: Array<{ id: string; title: string }>
  /**
   * The questions pinned for the human and not yet resolved, oldest first (#2), each with its
   * markdown verbatim. Resolving one goes through `resolveQuestion`, which wakes the orchestrator.
   */
  openQuestions?: OrchestrationOpenQuestion[]
}

/** An open pinned question as the orchestrator node and the phone render it. */
export type OrchestrationOpenQuestion = Pick<
  OrchestrationQuestion,
  'id' | 'ticketId' | 'markdown' | 'options' | 'multiSelect' | 'createdAt'
>

/**
 * What the orchestrator node's controls and the phone read from a record: main's state, never the
 * renderer's projection, published again on every change that moves one of its fields.
 */
export function orchestrationControlState(record: OrchestrationRecord): OrchestrationControlState {
  const deferral = pacingDeferral(record)
  return {
    provider: record.provider,
    conversationId: record.conversationId,
    status: record.lifecycle?.status ?? 'running',
    ...(record.lifecycle?.status === 'paused' && record.lifecycle.resetsAt !== undefined
      ? { resetsAt: record.lifecycle.resetsAt }
      : {}),
    ...(deferral
      ? {
          pacing: {
            state: deferral.state,
            reason: deferral.reason,
            ...(deferral.retryAt !== undefined ? { retryAt: deferral.retryAt } : {})
          }
        }
      : {}),
    ...(spawnBudgetReached(record)
      ? { spawnCheckpoint: { used: record.spawnCount ?? 0, budget: spawnBudget(record) } }
      : {}),
    startable: startableTickets(record).map((ticket) => ({ id: ticket.id, title: ticket.title })),
    openQuestions: openOrchestrationQuestions(record).map(
      ({ id, ticketId, markdown, options, multiSelect, createdAt }) => ({
        id,
        ...(ticketId !== undefined ? { ticketId } : {}),
        markdown,
        ...(options ? { options, ...(multiSelect ? { multiSelect } : {}) } : {}),
        createdAt
      })
    )
  }
}

/** The human resolving a pinned question, with an optional note the orchestrator is woken with. */
export interface OrchestrationQuestionResolveRequest extends OrchestrationControlRequest {
  questionId: string
  note?: string
}

/** The orchestrator node's Start now: one forced spawn of one ticket, granted by the user. */
export interface OrchestrationForceStartRequest extends OrchestrationControlRequest {
  ticketId: string
}

export type OrchestrationForceStartResult = { ok: true } | { ok: false; message: string }

/** The renderer's side of the request, exposed on `window.orchestratorApi`. */
export interface OrchestratorApi {
  /**
   * A ticket session main wants on the canvas. The renderer answers on `completeTicketSession`
   * once the session is up or has failed; the orchestrator's `spawn` call is waiting on it.
   */
  onStartTicketSession(callback: (requestId: string, request: TicketSessionCanvasRequest) => void): () => void
  completeTicketSession(requestId: string, result: TicketSessionCanvasAnswer): void
  /**
   * The node exists but its session is not up yet (and again once it has a conversation id), so
   * main can link it to its ticket at once and a spawn that outlasts its wait stays tracked (#1).
   */
  progressTicketSession(requestId: string, progress: TicketSessionProgress): void
  /**
   * Main treats the start of this node's session as failed, however it got there. The renderer
   * closes the node, which stops the session whether or not it has come up since.
   */
  onCancelTicketSession(callback: (nodeId: string) => void): () => void
  onCleanupTicket(callback: (requestId: string, request: TicketCleanupRequest) => void): () => void
  completeCleanupTicket(requestId: string, result: TicketCleanupResult): void
  /** Whether Jev can route this orchestrator's tickets (#36); never the key itself. */
  jevReachability(): Promise<JevReachability>
  orchestrationState(request: OrchestrationControlRequest): Promise<OrchestrationControlState | null>
  resumeOrchestration(request: OrchestrationControlRequest): Promise<OrchestrationControlState | null>
  stopOrchestration(request: OrchestrationControlRequest): Promise<OrchestrationControlState | null>
  /** Continue (+20) at a spawn checkpoint: raises the budget and wakes the orchestrator. */
  continueSpawns(request: OrchestrationControlRequest): Promise<OrchestrationControlState | null>
  /** Grants one forced spawn and asks the orchestrator to run it. */
  forceStartTicket(request: OrchestrationForceStartRequest): Promise<OrchestrationForceStartResult>
  /**
   * Resolves a pinned question and wakes the orchestrator with `[Toucan: user resolved Q<n>]`.
   * A question already resolved changes nothing and wakes nobody.
   */
  resolveQuestion(request: OrchestrationQuestionResolveRequest): Promise<OrchestrationControlState | null>
  onOrchestrationState(callback: (state: OrchestrationControlState) => void): () => void
}

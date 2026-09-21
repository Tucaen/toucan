/**
 * The chat node's reporting policy: every rule behind what a conversation reports upward - the
 * attention records it raises, the sidebar status it presents, the stall verdict, the generated
 * title, and the ticket-activity window - as pure functions over conversation state.
 * `use-conversation-reporting.ts` owns the refs and effects that run these against a live
 * session; nothing here touches React, so the rules run under the plain node test runner
 * (`tests/conversation-reporting.test.ts`).
 *
 * Every attention key produced here is stable across ACP session replay, which is what keeps a
 * restored conversation from re-raising something the user already dealt with (shared/attention.ts).
 */
import { attentionTextKey, type AttentionAction, type AttentionKind } from '../../shared/attention'
import { isFinalAssistantMessage } from '../../shared/agent'
import type { AgentChatMessage, AgentChatStatus } from '../../shared/agent-transcript'
import type { TerminalNodeStatus } from '../../shared/terminal'

// A 'working' session with no new message/activity/plan event for this long is flagged
// as stalled. Long enough that a slow tool call (build, long shell command) doesn't
// false-positive, short enough to catch a genuinely wedged agent.
/** @internal exported for tests */
export const STALL_THRESHOLD_MS = 5 * 60 * 1000
export const STALL_CHECK_INTERVAL_MS = 15 * 1000

export function isStalled(now: number, lastProgressAt: number): boolean {
  return now - lastProgressAt > STALL_THRESHOLD_MS
}

/** The sidebar only cares whether the agent is busy, blocked, waiting on us, or stuck. */
export function sidebarStatus(
  status: AgentChatStatus,
  awaitingApproval: boolean,
  unreadKind: AttentionKind | undefined,
  stalled: boolean
): TerminalNodeStatus {
  if (status === 'exited') return 'exited'
  if (status === 'auth_required' || awaitingApproval) return 'attention'
  if (status === 'starting') return 'starting'
  if (status === 'working') return stalled ? 'stalled' : 'working'
  // A dormant node has no live approval or auth state left, so the record is the only thing that
  // still knows the session was blocked - reading it back as a mere 'result' would understate it.
  if (unreadKind === 'approval' || unreadKind === 'auth' || unreadKind === 'failure') return 'attention'
  return unreadKind ? 'result' : 'idle'
}

/** Who the reports name: the node they send the user to, and the session behind it. */
export interface ReportingIdentity {
  nodeId: string
  label: string
  /** The ACP conversation once there is one; until then the node's durable session id. */
  sourceId: string
}

/**
 * Carried across renders to recognize the completed-turn edge and which final answer the turn
 * produced. Kept as one value so the transition below is a pure fold rather than three refs.
 */
export interface TurnResultTracking {
  previousStatus: AgentChatStatus
  previousFinalAnswerCount: number
  turnStartFinalAnswerCount: number
}

export const initialTurnResultTracking: TurnResultTracking = {
  previousStatus: 'starting',
  previousFinalAnswerCount: 0,
  turnStartFinalAnswerCount: 0
}

/**
 * A turn that finished while the user was looking elsewhere is a result they have not read.
 * Keyed by the answer itself, so a replayed transcript lands on the record it already made.
 */
export function trackTurnResult(
  state: TurnResultTracking,
  identity: ReportingIdentity,
  input: { status: AgentChatStatus; messages: readonly AgentChatMessage[]; selected: boolean }
): { state: TurnResultTracking; raise: AttentionAction | null } {
  const finalAnswers = input.messages.filter(isFinalAssistantMessage)
  const next: TurnResultTracking = {
    previousStatus: input.status,
    previousFinalAnswerCount: finalAnswers.length,
    turnStartFinalAnswerCount:
      state.previousStatus !== 'working' && input.status === 'working'
        ? state.previousFinalAnswerCount
        : state.turnStartFinalAnswerCount
  }
  const finishedTurn = state.previousStatus === 'working' && input.status === 'ready'
  if (!finishedTurn || input.selected) return { state: next, raise: null }
  const answer = finalAnswers.slice(next.turnStartFinalAnswerCount).at(-1)
  if (!answer) return { state: next, raise: null }
  return {
    state: next,
    raise: {
      type: 'raise',
      signal: {
        nodeId: identity.nodeId,
        kind: 'result',
        key: attentionTextKey(`${answer.id}:${answer.text}`),
        sourceId: identity.sourceId,
        summary: `${identity.label} finished a turn`
      }
    }
  }
}

/**
 * A request the session is parked on is its own condition: the ACP request id is the key, so the
 * same request seen twice is one record, and answering it retires that record rather than
 * marking it read. A tool permission and a structured question set are one condition here, not
 * two - both are the agent waiting on an answer, and a chat stalled on either has to be findable
 * from a list (the phone's "needs approval" badge reads exactly this record).
 */
export function pendingRequestActions(
  previousRequestId: string | null,
  request: { id: string; title?: string } | null,
  identity: ReportingIdentity
): AttentionAction[] {
  const actions: AttentionAction[] = []
  if (previousRequestId && previousRequestId !== (request?.id ?? null)) {
    actions.push({ type: 'resolve', nodeId: identity.nodeId, kind: 'approval', key: previousRequestId })
  }
  if (request) {
    actions.push({
      type: 'raise',
      signal: {
        nodeId: identity.nodeId,
        kind: 'approval',
        key: request.id,
        sourceId: identity.sourceId,
        summary: request.title ?? `${identity.label} needs approval`
      }
    })
  }
  return actions
}

/**
 * Sign-in is a standing condition rather than an event, so it is raised while it holds and
 * retired the moment the session gets past it.
 */
export function authAttentionAction(authRequired: boolean, identity: ReportingIdentity): AttentionAction {
  if (!authRequired) return { type: 'resolve', nodeId: identity.nodeId, kind: 'auth' }
  return {
    type: 'raise',
    signal: {
      nodeId: identity.nodeId,
      kind: 'auth',
      key: 'auth',
      sourceId: identity.sourceId,
      summary: `${identity.label} needs you to sign in`
    }
  }
}

/**
 * Failures are keyed by their text: the same error reported again - live or replayed - is the
 * same condition, while a different one is worth its own record.
 */
export function failureAttentionAction(
  failure: string | null,
  failureKey: string | null,
  identity: ReportingIdentity
): AttentionAction | null {
  if (!failure) return null
  return {
    type: 'raise',
    signal: {
      nodeId: identity.nodeId,
      kind: 'failure',
      key: failureKey ?? attentionTextKey(failure),
      sourceId: identity.sourceId,
      summary: failure
    }
  }
}

export { generatedConversationTitle } from '../../shared/conversation-title'

/**
 * Where the running turn began, observed on the idle->working edge because the transcript alone
 * cannot tell a steer sent mid-turn from a new turn. The start is kept once the turn ends:
 * between turns the turn that just finished *is* the last completed one, and its writes are what
 * the ticket card shows. `ticketActivityDigest` below is what makes the report fire on a change
 * of *contents* rather than on every streamed event - the caller compares it against the last
 * digest it reported.
 */
export interface TicketTurnTracking {
  startedAt?: number
  wasRunning: boolean
}

export const initialTicketTurnTracking: TicketTurnTracking = { wasRunning: false }

export function trackTicketTurn(
  state: TicketTurnTracking,
  input: { working: boolean; transcriptLength: number }
): TicketTurnTracking {
  return {
    startedAt: input.working && !state.wasRunning ? input.transcriptLength : state.startedAt,
    wasRunning: input.working
  }
}

export function ticketActivityDigest(working: boolean, paths: readonly string[]): string {
  return `${working}\n${paths.join('\n')}`
}

import {
  AGENT_TURN_OUTCOME_LIMIT,
  type AgentActivity,
  type AgentAuthMethod,
  type AgentCommand,
  type AgentCreateResult,
  type AgentDecisionRequest,
  type AgentEffortState,
  type AgentEvent,
  type AgentMessagePresentation,
  type AgentModeState,
  type AgentModelState,
  type AgentPermissionOption,
  type AgentPlanEntry,
  type AgentTurnOutcome
} from './agent'
import { mergeActivity } from './agent-activity'
import {
  initialAssistantPresentation,
  settleCurrentAssistantTurn,
  settleReplayedAssistantTurns
} from './assistant-presentation'
import { mergeSessionUsage, type SessionUsageInput } from './session-usage'

/**
 * The transcript a session's `AgentEvent` stream folds into, and the pure reducer that folds it.
 * Every host that observes a session - the renderer's chat node today, the main process or a
 * remote server tomorrow - derives an identical transcript by running the same `foldAgentEvent`
 * over the same events, so nothing here may touch React, Electron, the DOM, or wall clocks
 * (callers pass `now`). Renderer-only concerns stay out: optimistic send bookkeeping, queued
 * badges, and delivery flags are the hook's business and reach this state only as plain message
 * patches. Presentation derivations (reasoning blocks, prose pending decisions, attention) remain
 * selectors over this state in their own pure modules.
 */

/** One image the captain attached to a message; base64 bytes without the `data:` URL prefix. */
export interface AgentImageAttachment {
  id: string
  data: string
  mimeType: string
}

export interface AgentChatMessage {
  id: string
  role: 'user' | 'assistant' | 'thought'
  text: string
  /**
   * Images the captain attached to this message. They stay on the message so a pasted screenshot
   * remains visible in the transcript instead of collapsing into a text summary of itself.
   * Render state only: provider replay of a resumed conversation does not return them.
   */
  images?: AgentImageAttachment[]
  /** True until the agent actually starts processing this message (only possible for messages sent while busy). */
  queued?: boolean
  /** True if delivery genuinely failed or expired (e.g. a queued send timed out in the wake gate) - never set alongside `queued`. */
  failed?: boolean
  /** Exact pending decision answered through its pinned controls; local UI metadata only. */
  decisionReplyTo?: string
  /** A decision answer has been displayed optimistically but transport has not accepted it yet. */
  deliveryPending?: boolean
  /** False while ACP is still streaming this assistant message; true after turn completion/replay. */
  complete?: boolean
  /** Provider-reported or turn-inferred distinction between interim narration and the result. */
  presentation?: AgentMessagePresentation
  /** Whether an unphased assistant message still awaits its turn boundary classification. */
  presentationProvisional?: boolean
}

export type AgentTranscriptEntry =
  | { type: 'message'; id: string; role: AgentChatMessage['role'] }
  | { type: 'activity'; id: string }
  | { type: 'outcome'; id: string }

export function agentTranscriptEntryKey(entry: AgentTranscriptEntry): string {
  if (entry.type === 'message') return `message:${entry.role}:${entry.id}`
  return `${entry.type}:${entry.id}`
}

export interface AgentApprovalState {
  id: string
  title: string
  options: AgentPermissionOption[]
  activity?: AgentActivity
}

export type AgentChatStatus = 'starting' | 'ready' | 'working' | 'auth_required' | 'exited'

export interface AgentTranscriptState {
  /** The provider session identity, once the stream or create result reported one. */
  sessionId: string | null
  messages: AgentChatMessage[]
  /** Tool activity by call id; `mergeActivity` folds ACP's patch-style updates per id. */
  activities: Record<string, AgentActivity>
  /** Failed and cancelled turn boundaries, retained as visible transcript entries. */
  outcomes: AgentTurnOutcome[]
  /** First-seen event order used to place activity and reasoning inline with dialogue. */
  transcript: AgentTranscriptEntry[]
  plan: AgentPlanEntry[]
  approval: AgentApprovalState | null
  /** FIFO of provider-native questions; the head is the one presented. */
  decisionRequests: AgentDecisionRequest[]
  authMethods: AgentAuthMethod[]
  /** A sign-in URL surfaced during an auth cycle, kept apart from `detail` so it stays actionable. */
  authLink: string | null
  modes: AgentModeState | null
  models: AgentModelState | null
  efforts: AgentEffortState | null
  /** Slash commands and skills this session advertises. */
  commands: AgentCommand[]
  status: AgentChatStatus
  usage: SessionUsageInput | null
  detail?: string
  /** The last reported failure, kept apart from `detail` (which any status message overwrites). */
  failure: string | null
  /** Stable identity for a turn-scoped failure; generic session errors fall back to their text. */
  failureKey: string | null
}

export function initialAgentTranscriptState(): AgentTranscriptState {
  return {
    sessionId: null,
    messages: [],
    activities: {},
    outcomes: [],
    transcript: [],
    plan: [],
    approval: null,
    decisionRequests: [],
    authMethods: [],
    authLink: null,
    modes: null,
    models: null,
    efforts: null,
    commands: [],
    status: 'starting',
    usage: null,
    detail: undefined,
    failure: null,
    failureKey: null
  }
}

/**
 * Records an entry in first-seen order. Deduplication is the caller's job: messages and
 * activities check their own collections (whose identities mirror the entry key) before calling,
 * so folding a chunk or patch for a known id never rescans the order.
 */
function withTranscriptEntry(state: AgentTranscriptState, entry: AgentTranscriptEntry): AgentTranscriptState {
  return { ...state, transcript: [...state.transcript, entry] }
}

/**
 * Outcomes cannot use their own collection as the "seen before" check: the list is bounded, and
 * eviction must not let a re-reported turn id enter the order twice, so they scan the (rarely
 * appended) transcript itself.
 */
function hasTranscriptEntry(state: AgentTranscriptState, entry: AgentTranscriptEntry): boolean {
  const key = agentTranscriptEntryKey(entry)
  return state.transcript.some((existing) => agentTranscriptEntryKey(existing) === key)
}

function foldMessage(
  state: AgentTranscriptState,
  event: Extract<AgentEvent, { type: 'message' }>
): AgentTranscriptState {
  const existing = state.messages.findIndex((message) => message.id === event.messageId && message.role === event.role)
  if (existing < 0) {
    const next = withTranscriptEntry(state, { type: 'message', id: event.messageId, role: event.role })
    return {
      ...next,
      messages: [
        ...next.messages,
        {
          id: event.messageId,
          role: event.role,
          text: event.text,
          complete: event.role === 'assistant' ? false : undefined,
          ...(event.role === 'assistant' ? initialAssistantPresentation(event.presentation) : {})
        }
      ]
    }
  }
  return {
    ...state,
    messages: state.messages.map((message, index) =>
      index === existing
        ? {
            ...message,
            text: message.text + event.text,
            ...(event.role === 'assistant' && event.presentation
              ? initialAssistantPresentation(event.presentation)
              : {})
          }
        : message
    )
  }
}

function foldTurnOutcome(
  state: AgentTranscriptState,
  event: Extract<AgentEvent, { type: 'turn_failed' | 'turn_cancelled' }>
): AgentTranscriptState {
  const outcome: AgentTurnOutcome = {
    id: event.turnId,
    status: event.type === 'turn_failed' ? 'failed' : 'cancelled',
    message: event.message
  }
  const entry: AgentTranscriptEntry = { type: 'outcome', id: event.turnId }
  const next = hasTranscriptEntry(state, entry) ? state : withTranscriptEntry(state, entry)
  const outcomes = next.outcomes.some((candidate) => candidate.id === outcome.id)
    ? next.outcomes
    : [...next.outcomes, outcome].slice(-AGENT_TURN_OUTCOME_LIMIT)
  return event.type === 'turn_failed'
    ? { ...next, outcomes, failure: event.message, failureKey: event.turnId }
    : { ...next, outcomes }
}

/**
 * Folds one live or replayed `AgentEvent` into the transcript. `now` stamps first-seen activity
 * timing (ACP reports none), passed in so replays and tests stay deterministic.
 */
export function foldAgentEvent(state: AgentTranscriptState, event: AgentEvent, now: number): AgentTranscriptState {
  switch (event.type) {
    case 'status':
      return { ...state, status: event.status === 'idle' ? 'ready' : event.status, detail: event.message }
    case 'session':
      return { ...state, sessionId: event.sessionId }
    case 'message':
      return foldMessage(state, event)
    case 'turn_complete':
      return { ...state, messages: settleCurrentAssistantTurn(state.messages) }
    case 'turn_failed':
    case 'turn_cancelled':
      return foldTurnOutcome(state, event)
    case 'activity': {
      // A known call id already holds its transcript slot; skip the order scan on every patch.
      const next = state.activities[event.activity.id]
        ? state
        : withTranscriptEntry(state, { type: 'activity', id: event.activity.id })
      return {
        ...next,
        activities: {
          ...next.activities,
          [event.activity.id]: mergeActivity(next.activities[event.activity.id], event.activity, now)
        }
      }
    }
    case 'plan':
      return { ...state, plan: event.entries }
    case 'modes':
      // An update that names only the current mode must not blank an already-known mode list.
      return {
        ...state,
        modes:
          event.modes.availableModes.length > 0
            ? event.modes
            : { ...event.modes, availableModes: state.modes?.availableModes ?? [] }
      }
    case 'models':
      return { ...state, models: event.models }
    case 'efforts':
      return { ...state, efforts: event.efforts }
    case 'commands':
      return { ...state, commands: event.commands }
    case 'approval':
      return {
        ...state,
        approval: {
          id: event.approvalId,
          title: event.title,
          options: event.options,
          ...(event.activity ? { activity: event.activity } : {})
        }
      }
    case 'approval_resolved':
      // A stale resolution (an already-superseded approval) must not clear a newer request.
      return state.approval?.id === event.approvalId ? { ...state, approval: null } : state
    case 'decision_request': {
      const existing = state.decisionRequests.findIndex((request) => request.id === event.request.id)
      return {
        ...state,
        decisionRequests:
          existing < 0
            ? [...state.decisionRequests, event.request]
            : state.decisionRequests.map((request, index) => (index === existing ? event.request : request))
      }
    }
    case 'decision_resolved':
      return {
        ...state,
        decisionRequests: state.decisionRequests.filter((request) => request.id !== event.requestId)
      }
    case 'auth':
      // A fresh auth-required cycle invalidates any sign-in link surfaced by a previous one.
      return { ...state, authMethods: event.methods, authLink: null }
    case 'auth_link':
      return { ...state, authLink: event.url }
    case 'usage':
      // A patch, not a replacement - see mergeSessionUsage.
      return {
        ...state,
        usage: mergeSessionUsage(state.usage, { used: event.used, size: event.size, cost: event.cost })
      }
    case 'error':
      return { ...state, detail: event.message, failure: event.message, failureKey: null }
  }
}

/**
 * Applies what `AgentCreateResult` reports beyond its replayed events. Replay itself must be
 * folded through `foldAgentEvent` first (the same path live events take); this then reconstructs
 * the replayed turn boundaries - resume replay carries no `turn_complete` notifications, so each
 * boundary is inferred from its user message - and lands the create status.
 */
export function applyAgentCreateResult(state: AgentTranscriptState, result: AgentCreateResult): AgentTranscriptState {
  const next: AgentTranscriptState = {
    ...state,
    ...(result.sessionId ? { sessionId: result.sessionId } : {}),
    ...(result.authMethods ? { authMethods: result.authMethods } : {}),
    ...(result.modes ? { modes: result.modes } : {}),
    ...(result.models ? { models: result.models } : {}),
    ...(result.efforts ? { efforts: result.efforts } : {}),
    ...(result.commands ? { commands: result.commands } : {})
  }
  if (result.status === 'ready') {
    return { ...next, messages: settleReplayedAssistantTurns(next.messages), status: 'ready' }
  }
  if (result.status === 'auth_required') return { ...next, status: 'auth_required' }
  return { ...next, status: 'exited', detail: result.message }
}

/**
 * Records a locally originated user message (an optimistic send) in transcript order. The echo the
 * provider later streams back is deduplicated against it by the sender, not here: a host that
 * never sends optimistically folds the echo as the message itself.
 */
export function appendLocalUserMessage(state: AgentTranscriptState, message: AgentChatMessage): AgentTranscriptState {
  const entry: AgentTranscriptEntry = { type: 'message', id: message.id, role: message.role }
  const next = hasTranscriptEntry(state, entry) ? state : withTranscriptEntry(state, entry)
  return { ...next, messages: [...next.messages, message] }
}

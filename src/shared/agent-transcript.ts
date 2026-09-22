import {
  AGENT_TURN_OUTCOME_LIMIT,
  type AgentActivity,
  type AgentAuthMethod,
  type AgentCommand,
  type AgentCreateResult,
  type AgentDecisionRequest,
  type AgentEffortState,
  type AgentEvent,
  type AgentImageAttachment,
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
import type { AgentDecisionDelegation } from './decision-delegation'
import type { AgentRoutineDelegation } from './routine-delegation'

/**
 * The transcript a session's `AgentEvent` stream folds into, and the pure reducer that folds it.
 * Every host that observes a session - the renderer's chat node today, the main process or a
 * remote server tomorrow - derives an identical transcript by running the same `foldAgentEvent`
 * over the same events, so nothing here may touch React, Electron, the DOM, or wall clocks
 * (callers pass `now`). A client's own inputs - the optimistic prompt start, a selector click,
 * answering an approval, delivery bookkeeping for a locally rendered send - fold through the same
 * reducer as `LocalAgentEvent`s, so this module is the single writer of conversation state and the
 * precedence rule lives here once: main wins for anything that crossed the seam. Presentation
 * derivations (reasoning blocks, prose pending decisions, attention) remain selectors over this
 * state in their own pure modules.
 */

export interface AgentChatMessage {
  id: string
  role: 'user' | 'assistant' | 'thought'
  text: string
  /**
   * Images this message carries - pasted by the captain, or sent by the agent as an `image`
   * content chunk. A captain's attachments are render state only: provider replay of a resumed
   * conversation does not return them. Either way they stay on the message so the picture itself
   * remains in the transcript instead of collapsing into a text summary of itself.
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

/**
 * Inputs that originate on the observing client rather than in main's event stream, folded through
 * the same `foldAgentEvent` so no host writes conversation state anywhere else. A local fold only
 * ever anticipates main's answer: anything main later reports about the same fact lands on top of
 * it (`statusOrigin` is how the status fold enforces that).
 */
export type LocalAgentEvent =
  /** An optimistically rendered send taking its transcript slot ahead of the provider's echo. */
  | { type: 'local_user_message'; message: AgentChatMessage }
  /** Transport accepted (or the echo arrived for) a locally rendered send: shed its delivery flags. */
  | { type: 'local_message_delivered'; messageId: string }
  /** Delivery genuinely failed or expired; never rendered identically to a delivered message. */
  | { type: 'local_send_failed'; messageId: string }
  /** A prompt left this client while the session was idle: show `working` before main confirms it. */
  | { type: 'local_prompt_started' }
  /** That prompt's transport settled `ok: false`; undoes the optimism iff main never spoke. */
  | { type: 'local_prompt_failed'; message?: string }
  /** A renderer-local notice (composition failure, refused selection) for the transient detail line. */
  | { type: 'local_detail'; message?: string }
  /** An `authenticate()` call is underway; the session is transiently `starting`. */
  | { type: 'local_auth_started' }
  /** The `authenticate()` RPC verdict - main's answer delivered as a return value, not an event. */
  | { type: 'local_auth_settled'; status: AgentCreateResult['status']; message?: string }
  /** This client answered the approval; the broker's `approval_resolved` follows for everyone. */
  | { type: 'local_approval_resolved'; approvalId: string }
  /** This client answered the question; the broker's `decision_resolved` follows for everyone. */
  | { type: 'local_decision_resolved'; requestId: string }
  | { type: 'local_mode_selected'; modeId: string }
  | { type: 'local_model_selected'; modelId: string }
  | { type: 'local_effort_selected'; effortId: string }

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
  /** The routine-delegation policy this session's adapter launched with, from the create result. */
  routineDelegation: AgentRoutineDelegation | null
  /** The decision-delegation policy this session launched with, from the same create result. */
  decisionDelegation: AgentDecisionDelegation | null
  status: AgentChatStatus
  /**
   * Who last set `status`: `main` for anything that crossed the seam (a status event, a create or
   * auth verdict), `local` for this client's optimistic anticipation. A local fold may only undo
   * a status it set itself - once main has spoken, main wins.
   */
  statusOrigin: 'main' | 'local'
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
    routineDelegation: null,
    decisionDelegation: null,
    status: 'starting',
    statusOrigin: 'main',
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

/** Applies a delivery-flag patch to one locally rendered message, leaving every other untouched. */
function patchMessage(
  state: AgentTranscriptState,
  messageId: string,
  patch: (message: AgentChatMessage) => AgentChatMessage
): AgentTranscriptState {
  return {
    ...state,
    messages: state.messages.map((message) => (message.id === messageId ? patch(message) : message))
  }
}

/**
 * The images a chunk contributes, stamped with ids that are stable for the message they land on.
 * ACP sends an assistant's images as their own chunks of the same message, so the position an
 * image already occupies is the only identity available - `already` is what the message holds so
 * far, which makes the id deterministic under replay rather than a fresh random per fold.
 */
function messageImages(
  event: Extract<AgentEvent, { type: 'message' }>,
  already: AgentImageAttachment[]
): AgentImageAttachment[] | undefined {
  if (!event.images?.length) return undefined
  return event.images.map((image, index) => ({ id: `${event.messageId}#${already.length + index}`, ...image }))
}

function foldMessage(
  state: AgentTranscriptState,
  event: Extract<AgentEvent, { type: 'message' }>
): AgentTranscriptState {
  const existing = state.messages.findIndex((message) => message.id === event.messageId && message.role === event.role)
  if (existing < 0) {
    const next = withTranscriptEntry(state, { type: 'message', id: event.messageId, role: event.role })
    const images = messageImages(event, [])
    return {
      ...next,
      messages: [
        ...next.messages,
        {
          id: event.messageId,
          role: event.role,
          text: event.text,
          ...(images ? { images } : {}),
          complete: event.role === 'assistant' ? false : undefined,
          ...(event.role === 'assistant' ? initialAssistantPresentation(event.presentation) : {})
        }
      ]
    }
  }
  return {
    ...state,
    messages: state.messages.map((message, index) => {
      if (index !== existing) return message
      const images = messageImages(event, message.images ?? [])
      return {
        ...message,
        text: message.text + event.text,
        ...(images ? { images: [...(message.images ?? []), ...images] } : {}),
        ...(event.role === 'assistant' && event.presentation ? initialAssistantPresentation(event.presentation) : {})
      }
    })
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
 * Folds one live, replayed, or locally originated event into the transcript. `now` stamps
 * first-seen activity timing (ACP reports none), passed in so replays and tests stay deterministic.
 */
export function foldAgentEvent(
  state: AgentTranscriptState,
  event: AgentEvent | LocalAgentEvent,
  now: number
): AgentTranscriptState {
  switch (event.type) {
    case 'status': {
      // A session main reports past auth ('ready'/'working') has no live sign-in cycle left; clear
      // its methods and link so no reader shows a stale panel. 'starting' must not clear them: it
      // is also the transient state mid-reauth, while the sign-in link has to stay actionable.
      const authOver = event.status === 'ready' || event.status === 'working'
      return {
        ...state,
        status: event.status,
        statusOrigin: 'main',
        detail: event.message,
        ...(authOver ? { authMethods: [], authLink: null } : {})
      }
    }
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
    case 'local_approval_resolved':
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
    case 'local_decision_resolved':
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
    case 'local_user_message':
      return appendLocalUserMessage(state, event.message)
    case 'local_message_delivered':
      return patchMessage(state, event.messageId, (message) => {
        const { failed: _failed, deliveryPending: _deliveryPending, ...rest } = message
        return { ...rest, queued: false }
      })
    case 'local_send_failed':
      return patchMessage(state, event.messageId, (message) => ({
        ...message,
        queued: false,
        failed: true,
        deliveryPending: false
      }))
    case 'local_prompt_started':
      return { ...state, status: 'working', statusOrigin: 'local' }
    case 'local_prompt_failed':
      // Main's status events (`promptFailure` in acp-session-manager.ts) stay authoritative for a
      // prompt that crossed the agent boundary: they arrive before the prompt promise settles, and
      // forcing `ready` over them would hide the sign-in panel an OAuth failure just raised
      // (GitHub issue #156). Only a failure that left the local optimistic `working` untouched -
      // a composition error or a pre-turn refusal - still has it to undo.
      return {
        ...state,
        detail: event.message,
        ...(state.status === 'working' && state.statusOrigin === 'local' ? { status: 'ready' as const } : {})
      }
    case 'local_detail':
      return { ...state, detail: event.message }
    case 'local_auth_started':
      return { ...state, status: 'starting', statusOrigin: 'local' }
    case 'local_auth_settled':
      // The RPC verdict is main's answer, delivered as a return value rather than an event.
      if (event.status === 'ready') {
        return { ...state, status: 'ready', statusOrigin: 'main', authMethods: [], authLink: null }
      }
      return {
        ...state,
        status: event.status === 'auth_required' ? 'auth_required' : 'exited',
        statusOrigin: 'main',
        detail: event.message
      }
    case 'local_mode_selected':
      return {
        ...state,
        modes: state.modes ? { ...state.modes, currentModeId: event.modeId } : state.modes
      }
    case 'local_model_selected':
      return {
        ...state,
        models: state.models ? { ...state.models, currentModelId: event.modelId } : state.models
      }
    case 'local_effort_selected':
      return {
        ...state,
        efforts: state.efforts ? { ...state.efforts, currentEffortId: event.effortId } : state.efforts
      }
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
    ...(result.commands ? { commands: result.commands } : {}),
    ...(result.routineDelegation ? { routineDelegation: result.routineDelegation } : {}),
    ...(result.decisionDelegation ? { decisionDelegation: result.decisionDelegation } : {}),
    statusOrigin: 'main'
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
 * @internal exported for tests
 */
export function appendLocalUserMessage(state: AgentTranscriptState, message: AgentChatMessage): AgentTranscriptState {
  const entry: AgentTranscriptEntry = { type: 'message', id: message.id, role: message.role }
  const next = hasTranscriptEntry(state, entry) ? state : withTranscriptEntry(state, entry)
  return { ...next, messages: [...next.messages, message] }
}

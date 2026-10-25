import {
  MODEL_CHANGE_WHILE_BUSY,
  type AgentActivity,
  type AgentModel,
  type AgentModelState
} from '../../src/shared/agent'
import { agentTranscriptEntryKey, foldAgentEvent, type AgentTranscriptState } from '../../src/shared/agent-transcript'
import {
  parseRemoteChatServerMessage,
  promptTextProblem,
  REMOTE_CHAT_ACTIVITY_ID_LIMIT,
  REMOTE_CHAT_HISTORY_KEY_LIMIT,
  type RemoteChatServerMessage
} from '../../src/shared/remote-chat'
import { openActivity, openMessage, type RemoteTranscriptPage } from '../../src/shared/remote-transcript-page'
import { pendingRequestFrom, type PendingRequest } from './chat-view'

/**
 * Everything the chat view's connection decides, without a socket. The hook owns the WebSocket and
 * the timers; this module owns what a frame, a drop, or a rejoin *means*, so reconnect correctness
 * - the hard part of reading a chat remotely - is testable as plain data.
 *
 * The convergence rule is deliberately dumb: a snapshot replaces the transcript wholesale, an
 * event folds through the same shared reducer every other host runs, and nothing is ever merged.
 * Rejoining after a drop therefore cannot duplicate a message (the snapshot is the whole truth at
 * that moment) and cannot lose one (the tail starts exactly after the snapshot, by the broker's
 * join contract on the host).
 *
 * Sending is the same discipline applied to the other direction. The composer draft lives in this
 * state rather than in the component, because "what happens to what you typed" is exactly the
 * decision a failed send has to get right: the text is only cleared once the host confirms it
 * started a turn, and a refusal or a drop puts it straight back. The sent message reaches the
 * transcript as the provider's own echoed event, never as a local copy, so the phone and the
 * desktop render one message.
 */

export type ChatConnectionPhase =
  /** No transcript yet; the first join (or a rejoin that lost the old state) is in flight. */
  | 'connecting'
  | 'live'
  /** The socket dropped; whatever transcript is shown is explicitly stale until the rejoin lands. */
  | 'reconnecting'
  /** The chat is no longer joinable: the desktop closed the node, or unlisted it. */
  | 'gone'

/**
 * A send is one slot, not a queue, because the composer is closed while a turn is working: there
 * is never a second prompt waiting behind the first.
 */
export type ChatSendState =
  | { status: 'idle' }
  /** Handed to the host; `text` is held so a refusal can hand it back to the composer. */
  | { status: 'sending'; requestId: string; text: string }
  | { status: 'failed'; message: string }

/**
 * One answer at a time, like the send slot, and for a stronger reason: the transcript only ever
 * presents one pending request, so a second answer in flight could only be an answer to something
 * the reader is no longer looking at.
 *
 * `target` is the *request's* id, not the correlation id, and it is kept on the failure too. That
 * is what makes a refusal self-retiring: a notice about the approval that was already answered
 * elsewhere is not shown against the next request to arrive.
 */
export type ChatAnswerState =
  | { status: 'idle' }
  | { status: 'answering'; requestId: string; target: string }
  | { status: 'failed'; target: string; message: string }

/**
 * One model change at a time, and - unlike a send - nothing optimistic about it. The selection
 * shown is always the one the *session* reports (`AgentTranscriptState.models`), so while a change
 * is on the wire the control says it is switching rather than pretending it already has; the new
 * selection appears when the session's own `models` event folds, which is the same moment the
 * desktop's picker learns about it.
 */
export type ChatModelState =
  | { status: 'idle' }
  /** Handed to the host; `modelId` is held so a refusal can name what it refused. */
  | { status: 'selecting'; requestId: string; modelId: string }
  | { status: 'failed'; message: string }

/**
 * What a tool card knows beyond the slim copy the transcript carries. The *presence* of an entry is
 * what "this card is open" means, so opening is asking and closing is forgetting: a body is a
 * point-in-time read of a call that may still be running, and dropping it on close is what makes
 * the next open a fresh one instead of a stale one shown as current.
 *
 * Deliberately outside `transcript`. A snapshot replaces the transcript wholesale and the tail
 * folds through the shared reducer, and neither may be able to put a body back into - or take one
 * out of - what a reader has open.
 */
export type ChatActivityBodyState =
  | { status: 'loading'; requestId: string }
  | { status: 'loaded'; activity: AgentActivity }
  | { status: 'failed'; message: string }

/**
 * The older part of a long chat the reader has scrolled back into (#54): pages the host sent on
 * request, joined into one contiguous stretch that ends exactly where the window begins.
 *
 * Kept beside `transcript`, never folded into it, so the snapshot rule stays what it was: a snapshot
 * replaces the window wholesale. Pages are only *kept* across one when they still provably end where
 * the new window starts - same position, same entry - and dropped otherwise; nothing is ever merged
 * into the window, and the tail never folds into a page.
 */
export interface ChatTranscriptHistory extends RemoteTranscriptPage {
  /** The key of the entry right after the last one here: the window's first, when they joined. */
  next: string
}

/** One page request at a time; the reader can only be at one top. */
export type ChatHistoryRequestState =
  | { status: 'idle' }
  /** `before` is the entry the page must end right ahead of, so a late reply can be checked. */
  | { status: 'loading'; requestId: string; before: string }
  | { status: 'failed'; message: string }

export interface ChatConnectionState {
  /** The window: the most recent part of the transcript, which every snapshot replaces wholesale. */
  transcript: AgentTranscriptState | null
  /** Where the window's first entry sits in the host's whole transcript; 0 is the beginning. */
  windowStart: number
  /** Older pages the reader loaded, or null; see `ChatTranscriptHistory`. */
  history: ChatTranscriptHistory | null
  historyRequest: ChatHistoryRequestState
  phase: ChatConnectionPhase
  draft: string
  send: ChatSendState
  answer: ChatAnswerState
  model: ChatModelState
  /** Open tool cards by activity id; see `ChatActivityBodyState`. */
  activityBodies: Record<string, ChatActivityBodyState>
}

/** @internal exported for tests */
export function initialChatConnectionState(): ChatConnectionState {
  return {
    transcript: null,
    windowStart: 0,
    history: null,
    historyRequest: { status: 'idle' },
    phase: 'connecting',
    draft: '',
    send: { status: 'idle' },
    answer: { status: 'idle' },
    model: { status: 'idle' },
    activityBodies: {}
  }
}

/**
 * A fresh connection that keeps a draft the device had already retained. This is what makes the
 * typed text survive the one failure that unmounts the whole screen: a revoked token sends the
 * phone back to pairing, and re-pairing must not cost the reader their message.
 */
export function restoredChatConnectionState(draft: string): ChatConnectionState {
  return { ...initialChatConnectionState(), draft }
}

/**
 * Folds one socket frame. A snapshot is a full resync - the first frame of every join, and the
 * host's repair when its own copy learned something the tail did not carry (a provider replay).
 * An event before any snapshot is dropped rather than folded onto nothing: folding it would
 * present a transcript with an unknowable gap at the front, which is the lie this design exists
 * to prevent.
 */
export function applyServerFrame(state: ChatConnectionState, raw: unknown, now: number): ChatConnectionState {
  const message = parseRemoteChatServerMessage(raw)
  if (!message) return state
  switch (message.type) {
    case 'prompt_result':
      // A verdict on a superseded send (one this state already gave up on) must not resurrect it.
      if (state.send.status !== 'sending' || state.send.requestId !== message.requestId) return state
      return message.ok
        ? { ...state, send: { status: 'idle' } }
        : recoverDraft(state, state.send.text, message.message ?? 'The host refused the message.')
    case 'answer_result': {
      if (state.answer.status !== 'answering' || state.answer.requestId !== message.requestId) return state
      // Accepted: the card itself retires when the session's own resolution event arrives, which
      // is the same source the client that lost the race learns it from.
      if (message.ok) return { ...state, answer: { status: 'idle' } }
      return {
        ...state,
        answer: {
          status: 'failed',
          target: state.answer.target,
          message: message.message ?? 'The host refused the answer.'
        }
      }
    }
    case 'model_result': {
      // A verdict on a superseded change (one this state already gave up on) must not revive it.
      if (state.model.status !== 'selecting' || state.model.requestId !== message.requestId) return state
      // Accepted: the *selection* is not set here. It arrives as the session's own `models` event,
      // so the phone and the desktop read one current model from one source.
      if (message.ok) return { ...state, model: { status: 'idle' } }
      return { ...state, model: { status: 'failed', message: message.message ?? 'The host refused the model.' } }
    }
    case 'activity_result': {
      // Matched on the id of the request this state is still waiting on, so a late reply for a card
      // the reader has since closed (or closed and reopened) cannot put a stale body on screen.
      const waiting = Object.entries(state.activityBodies).find(
        ([, body]) => body.status === 'loading' && body.requestId === message.requestId
      )
      if (!waiting) return state
      const [activityId] = waiting
      const body: ChatActivityBodyState =
        message.ok && message.activity
          ? { status: 'loaded', activity: message.activity }
          : { status: 'failed', message: message.message ?? 'The host did not send that tool call.' }
      return { ...state, activityBodies: { ...state.activityBodies, [activityId]: body } }
    }
    case 'history_result':
      return applyHistoryResult(state, message)
    case 'snapshot': {
      const start = message.start ?? 0
      return {
        ...state,
        transcript: message.state,
        windowStart: start,
        history: historyJoining(state.history, start, message.state),
        phase: 'live'
      }
    }
    case 'event':
      if (!state.transcript) return state
      return { ...state, transcript: foldAgentEvent(state.transcript, message.event, now) }
  }
}

/**
 * When this reader should tell the host they have read the chat, expressed as a key that changes
 * exactly at those moments - or null while there is nothing to have read yet.
 *
 * The desktop's rule is "having the node open is the user reaching its content, so anything raised
 * while it is selected clears too". A phone has the same moments and no more: the reader *arrives*
 * (the join's snapshot), and something lands *while they are still here*. The second one is
 * deliberately not every frame - a streaming turn would report a read per chunk - but the
 * transitions that actually raise attention on a chat node: a turn ending, and a failure. Both are
 * visible in the transcript the reader is looking at, which is what makes this a pure decision.
 *
 * Three details are load-bearing. The busy marker is not there to report a read at a turn's *start*
 * (it does, and that is one harmless idempotent frame); it is there so that a turn's *end* is a
 * change at all, since a settled transcript either side of it would otherwise carry one key. The
 * failure half is `failureKey ?? failure`, not `failureKey` alone: a session error folds with a
 * null key, and the canvas keys that condition on its text instead, so keying on the key alone
 * would leave behind the one badge a present reader most obviously meant to clear. And the settled
 * key counts the transcript, because a key built only from "settled, no failure" cannot tell
 * *nothing happened* from *a whole turn came and went while the socket was down* - the count is
 * read only when settled, so the entries a working turn appends never report a read of their own.
 */
export function readReportKey(state: ChatConnectionState): string | null {
  if (state.phase !== 'live' || !state.transcript) return null
  if (state.transcript.status === 'working' || state.transcript.status === 'starting') return 'busy'
  const failure = state.transcript.failureKey ?? state.transcript.failure ?? ''
  // Counted from the beginning of the chat, not the window: a rejoin after a whole turn can be sent
  // a window of the same length starting further on, and that is still something that happened.
  return `settled:${state.windowStart + state.transcript.transcript.length}:${failure}`
}

/** What this connection's transcript is blocked on; the rule itself is `pendingRequestFrom`. */
export function pendingRequest(state: ChatConnectionState): PendingRequest | null {
  return state.transcript ? pendingRequestFrom(state.transcript) : null
}

/**
 * Whether an answer to what is currently pending is on the wire. Keyed on the request rather than
 * on the slot alone, so a verdict that never arrived for a request that has since been resolved
 * elsewhere cannot leave the new card disabled.
 */
export function answerInFlight(state: ChatConnectionState): boolean {
  return state.answer.status === 'answering' && state.answer.target === pendingRequest(state)?.id
}

/**
 * The last refusal, but only while it still concerns the request the reader is looking at.
 *
 * A refusal deliberately re-enables the card rather than sealing it: most refusals are transient
 * (a socket that was not open, a host that could not deliver it) and have to be retryable. The one
 * that is not - losing the race - retires the card a moment later through the session's own
 * resolution event, and the host would refuse a second answer on the request id anyway, so a
 * retryable card cannot become a double answer.
 */
export function answerFailure(state: ChatConnectionState): string | null {
  if (state.answer.status !== 'failed') return null
  return state.answer.target === pendingRequest(state)?.id ? state.answer.message : null
}

/**
 * Why this answer cannot be sent right now, or null. Deliberately not a busy check: a pending
 * request is what a *working* turn is waiting on, so "the session is working" is never a reason to
 * refuse the one thing that would unblock it.
 * @internal exported for tests
 */
export function answerBlockedReason(state: ChatConnectionState, target: string): string | null {
  if (state.phase === 'gone') return 'This chat is no longer open on the desktop.'
  if (state.phase !== 'live') return 'Not connected.'
  if (pendingRequest(state)?.id !== target) return 'That request is no longer pending.'
  if (answerInFlight(state)) return 'Answering…'
  return null
}

/**
 * What this conversation is running on and what else it could run on, or null when the session has
 * not advertised a model choice at all (an adapter that exposes none, or a transcript that has not
 * arrived yet). Read straight off the shared reducer state, so it is the same selection the desktop
 * renders - the whole of scope "show the current model" is this one accessor plus a label.
 */
export function chatModels(state: ChatConnectionState): AgentModelState | null {
  return state.transcript?.models ?? null
}

/**
 * The advertised entry for the model in use. Null when the session named one this client has no
 * entry for, which a picker has to render as itself rather than as the first option it does know.
 */
export function currentModel(state: ChatConnectionState): AgentModel | null {
  const models = chatModels(state)
  if (!models) return null
  return models.availableModels.find((model) => model.id === models.currentModelId) ?? null
}

/**
 * Whether a model change is on the wire. The control is inert - not optimistic - while it is.
 * @internal exported for tests
 */
export function modelChangeInFlight(state: ChatConnectionState): boolean {
  return state.model.status === 'selecting'
}

/** The last refusal of a model change, kept until the next attempt replaces it. */
export function modelChangeFailure(state: ChatConnectionState): string | null {
  return state.model.status === 'failed' ? state.model.message : null
}

/**
 * Why this model cannot be picked right now, or null.
 *
 * The session-shaped half of this is deliberately the *desktop's* rule and not a stricter one of
 * the phone's: the desktop greys its pickers out while a session is starting or has exited and at
 * no other time, so a model change mid-turn is offered on both surfaces or on neither. The host
 * refuses independently with the session manager's own words, which is what makes a disagreement
 * visible rather than silent - exactly as it is for a prompt.
 */
export function modelPickerBlockedReason(state: ChatConnectionState): string | null {
  if (state.phase === 'gone') return 'This chat is no longer open on the desktop.'
  if (state.phase !== 'live') return 'Not connected.'
  if (modelChangeInFlight(state)) return 'Switching…'
  if (!chatModels(state)) return 'This agent does not offer a model choice.'
  const status = state.transcript?.status
  if (status === 'starting') return 'The session is still starting.'
  if (status === 'exited') return 'This session has exited.'
  // A conversation keeps one model for a whole turn. Worded from the shared constant because the
  // host refuses it in exactly these words too, and a greyed-out control whose reason differs from
  // the refusal behind it is worse than either wording alone.
  if (status === 'working') return MODEL_CHANGE_WHILE_BUSY
  return null
}

/**
 * Why *this* model cannot be picked, or null. The half that does not depend on which model is
 * `modelPickerBlockedReason`, so the control's disabled state and the gate on a tap are one rule
 * read at two granularities rather than two rules that can disagree.
 * @internal exported for tests
 */
export function modelChangeBlockedReason(state: ChatConnectionState, modelId: string): string | null {
  const blocked = modelPickerBlockedReason(state)
  if (blocked) return blocked
  const models = chatModels(state)
  if (!models) return 'This agent does not offer a model choice.'
  if (!models.availableModels.some((model) => model.id === modelId)) return 'That model is unavailable.'
  if (models.currentModelId === modelId) return 'That model is already selected.'
  return null
}

export type PendingModelChange = Extract<ChatModelState, { status: 'selecting' }>

/**
 * The model slot a pick would create, or null when it must not reach the socket. Split from
 * applying it for the same reason `plannedSend` is: the socket write sits between the two.
 */
export function plannedModelChange(
  state: ChatConnectionState,
  requestId: string,
  modelId: string
): PendingModelChange | null {
  if (modelChangeBlockedReason(state, modelId)) return null
  return { status: 'selecting', requestId, modelId }
}

export function withModelChange(state: ChatConnectionState, model: PendingModelChange): ChatConnectionState {
  return { ...state, model }
}

/** A change that never reached the socket, or whose socket died before the host confirmed it. */
export function modelChangeFailed(state: ChatConnectionState, message: string): ChatConnectionState {
  if (state.model.status !== 'selecting') return state
  return { ...state, model: { status: 'failed', message } }
}

export interface PendingActivityBody {
  activityId: string
  requestId: string
}

/**
 * The request opening this card would send, or null when it must not reach the socket: not
 * connected, a call this transcript does not hold (the host would only refuse it), or a card that
 * already is open. A failed card is not open - it is how a retry gets past the last refusal. Split
 * from applying it for the same reason `plannedSend` is: the socket write sits between the two.
 */
export function plannedActivityBody(
  state: ChatConnectionState,
  requestId: string,
  activityId: string
): PendingActivityBody | null {
  if (state.phase !== 'live') return null
  if (!transcriptActivity(state, activityId)) return null
  // The host drops a frame whose id exceeds the bound without a verdict, which would leave the card
  // loading for good; an id it could never accept is not worth a frame.
  if (activityId.length > REMOTE_CHAT_ACTIVITY_ID_LIMIT) return null
  const open = state.activityBodies[activityId]
  if (open && open.status !== 'failed') return null
  return { activityId, requestId }
}

/**
 * Whether an open card shows a call that has moved on since the body was read: the body is a
 * point-in-time read and tail events are slim, so a call still running when it was fetched keeps
 * producing output the card cannot see. Compared on status because that is the one change the slim
 * transcript always carries; the card says so and a close-and-reopen is the refresh.
 */
export function activityBodyStale(state: ChatConnectionState, activityId: string): boolean {
  const body = state.activityBodies[activityId]
  if (body?.status !== 'loaded') return false
  return body.activity.status !== transcriptActivity(state, activityId)?.status
}

export function withActivityBody(state: ChatConnectionState, planned: PendingActivityBody): ChatConnectionState {
  return {
    ...state,
    activityBodies: {
      ...state.activityBodies,
      [planned.activityId]: { status: 'loading', requestId: planned.requestId }
    }
  }
}

/** A request that never reached the socket, or whose socket died before the host answered it. */
export function activityBodyFailed(
  state: ChatConnectionState,
  activityId: string,
  message: string
): ChatConnectionState {
  if (state.activityBodies[activityId]?.status !== 'loading') return state
  return { ...state, activityBodies: { ...state.activityBodies, [activityId]: { status: 'failed', message } } }
}

/** Closes a card, whatever it held; a reply still in flight for it is then ignored. */
export function activityBodyClosed(state: ChatConnectionState, activityId: string): ChatConnectionState {
  if (!(activityId in state.activityBodies)) return state
  const { [activityId]: _closed, ...rest } = state.activityBodies
  return { ...state, activityBodies: rest }
}

export type PendingAnswer = Extract<ChatAnswerState, { status: 'answering' }>

/**
 * The answer slot a tap would create, or null when it must not reach the socket. Split from
 * applying it for the same reason `plannedSend` is: the socket write sits between the two, so the
 * caller decides once and then applies the decision it already made.
 */
export function plannedAnswer(state: ChatConnectionState, requestId: string, target: string): PendingAnswer | null {
  if (answerBlockedReason(state, target)) return null
  return { status: 'answering', requestId, target }
}

export function withAnswer(state: ChatConnectionState, answer: PendingAnswer): ChatConnectionState {
  return { ...state, answer }
}

/** An answer that never reached the socket, or whose socket died before the host confirmed it. */
export function answerFailed(state: ChatConnectionState, message: string): ChatConnectionState {
  if (state.answer.status !== 'answering') return state
  return { ...state, answer: { status: 'failed', target: state.answer.target, message } }
}

/**
 * The socket dropped. The transcript is kept for display - a phone that locked mid-turn should
 * come back to the conversation, not a blank screen - but the phase says out loud that it is
 * stale until the rejoin's snapshot replaces it.
 *
 * A send in flight when the socket died has an unknowable outcome, and the honest reading is the
 * pessimistic one: report it as not sent and return the text. Should it turn out to have landed,
 * the rejoin's snapshot shows the message and the reader simply does not send it again - far
 * better than silently dropping a prompt nobody knows was lost.
 */
export function connectionLost(state: ChatConnectionState): ChatConnectionState {
  const phase = state.transcript ? 'reconnecting' : 'connecting'
  // An answer in flight has the same unknowable outcome as a send, and the same honest reading:
  // report it as unconfirmed. The rejoin's snapshot then says whether the card is still pending,
  // which is the only trustworthy answer to "did it land".
  // A model change in flight is the same unknowable outcome, with the gentlest recovery of the
  // three: the rejoin's snapshot carries the session's current model, so the control says what
  // actually happened rather than what was asked for.
  // A card waiting on its body is the gentlest of all: nothing was changed, so the reply is simply
  // not coming and a retry on the rejoined socket asks again.
  // A page in flight is asked for again by the loader once the rejoin lands; nothing to report.
  const unpaged: ChatConnectionState =
    state.historyRequest.status === 'loading' ? { ...state, historyRequest: { status: 'idle' } } : state
  const dropped = Object.entries(unpaged.activityBodies).reduce(
    (current, [activityId, body]) =>
      body.status === 'loading' ? activityBodyFailed(current, activityId, DISCONNECTED_WHILE_FETCHING) : current,
    modelChangeFailed(answerFailed(unpaged, DISCONNECTED_WHILE_ANSWERING), DISCONNECTED_WHILE_SWITCHING)
  )
  if (dropped.send.status !== 'sending') return { ...dropped, phase }
  return { ...recoverDraft(dropped, dropped.send.text, DISCONNECTED_WHILE_SENDING), phase }
}

/** @internal exported for tests */
export const HISTORY_MISALIGNED = 'The earlier messages the host sent do not line up with this chat. Try again.'

/** @internal exported for tests */
export const DISCONNECTED_WHILE_FETCHING =
  'Disconnected before the host sent the full output. Try again once reconnected.'

/** @internal exported for tests */
export const DISCONNECTED_WHILE_SENDING =
  'Disconnected before the host confirmed the message. Check the transcript before sending it again.'

/** @internal exported for tests */
export const DISCONNECTED_WHILE_ANSWERING =
  'Disconnected before the host confirmed the answer. It is still pending if the card is still here.'

/** @internal exported for tests */
export const DISCONNECTED_WHILE_SWITCHING =
  'Disconnected before the host confirmed the model. The model shown once reconnected is the real one.'

/**
 * The pages a reader loaded, if they still end exactly where a new window starts: the position
 * matches and so does the entry, which is what proves this is the same transcript seen from a
 * window that has not moved. Anything else drops them - they were older entries relative to a
 * window that is gone, and the loader fetches whatever the reader scrolls back to again.
 *
 * A page is a point-in-time read, and the only parts of it that can still change are the ones
 * that were open when it was read. Those are kept current by the window, which carries everything
 * open; once one has finished the new window stops carrying it, so a page still holding its open
 * copy is stale and is dropped too rather than showing a call that runs forever.
 */
function historyJoining(
  history: ChatTranscriptHistory | null,
  start: number,
  recent: AgentTranscriptState
): ChatTranscriptHistory | null {
  if (!history || start === 0) return null
  const first = recent.transcript[0]
  if (!first || agentTranscriptEntryKey(first) !== history.next) return null
  if (history.start + history.entries.length !== start) return null
  const staleActivity = Object.values(history.activities).some(
    (activity) => openActivity(activity) && !recent.activities[activity.id]
  )
  const staleMessage = history.messages.some(
    (message) =>
      openMessage(message) &&
      !recent.messages.some((candidate) => candidate.id === message.id && candidate.role === message.role)
  )
  return staleActivity || staleMessage ? null : history
}

/** Where the oldest entry this client holds sits, and its key; null when it holds nothing. */
function oldestHeld(state: ChatConnectionState): { start: number; key: string } | null {
  const history = state.history
  const first = history?.entries[0] ?? state.transcript?.transcript[0]
  if (!first) return null
  return { start: history ? history.start : state.windowStart, key: agentTranscriptEntryKey(first) }
}

function applyHistoryResult(
  state: ChatConnectionState,
  message: Extract<RemoteChatServerMessage, { type: 'history_result' }>
): ChatConnectionState {
  const request = state.historyRequest
  if (request.status !== 'loading' || request.requestId !== message.requestId) return state
  if (!message.ok || !message.page) {
    return {
      ...state,
      historyRequest: { status: 'failed', message: message.message ?? 'The host did not send the earlier messages.' }
    }
  }
  // A resync can move the window while a page is on the wire. A page that no longer ends right where
  // the oldest entry held begins is not joined at all: if the anchor moved, the loader simply asks
  // again from the new one; if it did not, asking again would get the same misfit back, so say so.
  const oldest = oldestHeld(state)
  const page = message.page
  if (!oldest || oldest.key !== request.before) return { ...state, historyRequest: { status: 'idle' } }
  if (page.start + page.entries.length !== oldest.start) {
    return { ...state, historyRequest: { status: 'failed', message: HISTORY_MISALIGNED } }
  }
  const history = state.history
  return {
    ...state,
    historyRequest: { status: 'idle' },
    history: {
      start: page.start,
      entries: [...page.entries, ...(history?.entries ?? [])],
      messages: [...page.messages, ...(history?.messages ?? [])],
      activities: { ...page.activities, ...history?.activities },
      outcomes: [...page.outcomes, ...(history?.outcomes ?? [])],
      next: history?.next ?? request.before
    }
  }
}

/** Whether there is anything older than what this client holds to ask the host for. */
export function historyAvailable(state: ChatConnectionState): boolean {
  if (state.phase === 'gone' || !state.transcript) return false
  return (oldestHeld(state)?.start ?? 0) > 0
}

export type PendingHistory = Extract<ChatHistoryRequestState, { status: 'loading' }>

/**
 * The page request reaching the top would send, or null when it must not reach the socket: not
 * live, nothing older to ask for, or a page already on the wire. A failed request is not on the
 * wire, which is how a retry gets past the last refusal.
 */
export function plannedHistory(state: ChatConnectionState, requestId: string): PendingHistory | null {
  if (state.phase !== 'live' || state.historyRequest.status === 'loading') return null
  const oldest = oldestHeld(state)
  if (!oldest || oldest.start === 0) return null
  // The host drops a frame whose anchor exceeds the bound without a verdict.
  if (oldest.key.length > REMOTE_CHAT_HISTORY_KEY_LIMIT) return null
  return { status: 'loading', requestId, before: oldest.key }
}

export function withHistoryRequest(state: ChatConnectionState, planned: PendingHistory): ChatConnectionState {
  return { ...state, historyRequest: planned }
}

/** A page request that never reached the socket. */
export function historyFailed(state: ChatConnectionState, message: string): ChatConnectionState {
  if (state.historyRequest.status !== 'loading') return state
  return { ...state, historyRequest: { status: 'failed', message } }
}

/**
 * What the reader sees: the loaded pages followed by the window, as one transcript the shared view
 * derivation reads like any other. Where both hold the same call or message, the window's copy wins,
 * because the window is the one the tail keeps folding into - a call still running when its page was
 * read finishes in the window's copy (`transcriptWindow` carries whatever is still open).
 */
export function visibleTranscript(
  state: Pick<ChatConnectionState, 'transcript' | 'history'>
): AgentTranscriptState | null {
  const recent = state.transcript
  const history = state.history
  if (!recent || !history) return recent
  const windowEntries = new Set(recent.transcript.map(agentTranscriptEntryKey))
  const windowMessages = new Set(recent.messages.map((message) => `${message.role}:${message.id}`))
  const windowOutcomes = new Set(recent.outcomes.map((outcome) => outcome.id))
  return {
    ...recent,
    transcript: [
      ...history.entries.filter((entry) => !windowEntries.has(agentTranscriptEntryKey(entry))),
      ...recent.transcript
    ],
    messages: [
      ...history.messages.filter((message) => !windowMessages.has(`${message.role}:${message.id}`)),
      ...recent.messages
    ],
    activities: { ...history.activities, ...recent.activities },
    outcomes: [...history.outcomes.filter((outcome) => !windowOutcomes.has(outcome.id)), ...recent.outcomes]
  }
}

/** One call as the reader can see it, wherever it is held - the window's copy first. */
function transcriptActivity(state: ChatConnectionState, activityId: string): AgentActivity | undefined {
  return state.transcript?.activities[activityId] ?? state.history?.activities[activityId]
}

export function chatGone(state: ChatConnectionState): ChatConnectionState {
  return { ...state, phase: 'gone' }
}

/**
 * Rejoin pacing: quick first retries for the blips (a locked phone, a switched network), bounded
 * so a host that is genuinely down is probed every few seconds rather than hammered or abandoned.
 */
export function reconnectDelayMs(attempt: number): number {
  const bounded = Math.min(Math.max(attempt, 0), 4)
  return Math.min(500 * 2 ** bounded, 8_000)
}

export function draftChanged(state: ChatConnectionState, draft: string): ChatConnectionState {
  // Typing is the acknowledgement of a failure notice; keeping it up would leave the composer
  // permanently accusing the reader of a send they have already moved past.
  const send: ChatSendState = state.send.status === 'failed' ? { status: 'idle' } : state.send
  return { ...state, draft, send }
}

/**
 * Why the composer will not send right now, or null when it will. This is the *whole* busy policy
 * on the phone: sending is **blocked with a hint** while a turn is working rather than queued.
 * Queuing would mean a prompt sitting on the phone that neither the desktop's outbox nor the
 * transcript shows, and steering would mean an accidental nudge into a turn already in flight -
 * so a working session is simply not a send target, and the host independently refuses one, which
 * is what makes a race visible instead of silent.
 */
export function sendBlockedReason(state: ChatConnectionState): string | null {
  if (state.phase === 'gone') return 'This chat is no longer open on the desktop.'
  if (state.phase !== 'live') return 'Not connected.'
  if (state.send.status === 'sending') return 'Sending…'
  const status = state.transcript?.status
  if (status === undefined) return 'Not connected.'
  if (status === 'working' || status === 'starting') return 'Working — you can send when the turn finishes.'
  if (status === 'auth_required') return 'This session needs signing in on the desktop.'
  if (status === 'exited') return 'This session has exited.'
  if (pendingRequest(state)) {
    // The composer is *hidden* while a request is pending, not merely disabled: free text here
    // would bypass the channel the agent is actually waiting on, which is the desktop's rule too.
    // This reason is the invariant stated in one place, for any caller that renders it anyway.
    return 'Answer the request above to continue.'
  }
  return null
}

/**
 * Whether the plain composer may be on screen at all. One decision at a time is the rule both
 * clients keep, and on a phone the honest way to keep it is to take the text box away rather than
 * to leave a disabled one inviting the reader to type past the request.
 */
export function composerHidden(state: ChatConnectionState): boolean {
  return pendingRequest(state) !== null
}

/** What the composer offers, decided in one place so the button and the hint cannot disagree. */
export function canSendDraft(state: ChatConnectionState): boolean {
  return sendBlockedReason(state) === null && promptTextProblem(state.draft) === null
}

/**
 * The send slot a submit would create, or null when the composer has nothing to offer. Split from
 * applying it because the socket write sits between the two: the caller decides once, writes once,
 * and applies the decision it already made rather than re-deciding against newer state - which
 * would let a frame go out on the wire and then not clear the composer that sent it.
 */
export function plannedSend(state: ChatConnectionState, requestId: string): PendingSend | null {
  if (!canSendDraft(state)) return null
  return { status: 'sending', requestId, text: state.draft }
}

export type PendingSend = Extract<ChatSendState, { status: 'sending' }>

/**
 * Applies a planned send. The text leaves the composer immediately so it cannot be sent twice, but
 * it is held in the send slot until the verdict arrives - the composer is refilled by
 * `applyServerFrame`/`connectionLost`/`sendFailed` if the host refused it or never answered.
 */
export function withSend(state: ChatConnectionState, send: PendingSend): ChatConnectionState {
  return { ...state, draft: '', send }
}

/**
 * Plan and apply in one step, for callers with nothing to do in between.
 * @internal exported for tests
 */
export function beginSend(state: ChatConnectionState, requestId: string): ChatConnectionState {
  const planned = plannedSend(state, requestId)
  return planned ? withSend(state, planned) : state
}

/** A send that never reached the socket at all (it was not open); same recovery, stated locally. */
export function sendFailed(state: ChatConnectionState, message: string): ChatConnectionState {
  if (state.send.status !== 'sending') return state
  return recoverDraft(state, state.send.text, message)
}

/**
 * Reports a send as not delivered and puts its text back where it came from - unless the reader
 * has already typed something else, in which case their new draft outranks the recovered one and
 * the failure is reported on its own.
 */
function recoverDraft(state: ChatConnectionState, text: string, message: string): ChatConnectionState {
  return {
    ...state,
    draft: state.draft.length > 0 ? state.draft : text,
    send: { status: 'failed', message }
  }
}

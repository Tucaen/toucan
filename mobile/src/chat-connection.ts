import { foldAgentEvent, type AgentTranscriptState } from '../../src/shared/agent-transcript'
import { parseRemoteChatServerMessage, promptTextProblem } from '../../src/shared/remote-chat'

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

export interface ChatConnectionState {
  transcript: AgentTranscriptState | null
  phase: ChatConnectionPhase
  draft: string
  send: ChatSendState
}

export function initialChatConnectionState(): ChatConnectionState {
  return { transcript: null, phase: 'connecting', draft: '', send: { status: 'idle' } }
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
  if (message.type === 'prompt_result') {
    // A verdict on a superseded send (one this state already gave up on) must not resurrect it.
    if (state.send.status !== 'sending' || state.send.requestId !== message.requestId) return state
    return message.ok
      ? { ...state, send: { status: 'idle' } }
      : recoverDraft(state, state.send.text, message.message ?? 'The host refused the message.')
  }
  if (message.type === 'snapshot') return { ...state, transcript: message.state, phase: 'live' }
  if (!state.transcript) return state
  return { ...state, transcript: foldAgentEvent(state.transcript, message.event, now) }
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
  if (state.send.status !== 'sending') return { ...state, phase }
  return { ...recoverDraft(state, state.send.text, DISCONNECTED_WHILE_SENDING), phase }
}

export const DISCONNECTED_WHILE_SENDING =
  'Disconnected before the host confirmed the message. Check the transcript before sending it again.'

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
  if (state.transcript?.approval || (state.transcript?.decisionRequests.length ?? 0) > 0) {
    // Answering is a separate ticket; free text here would bypass the channel the agent is
    // actually waiting on, which is the desktop's rule too.
    return 'Waiting on an answer that has to be given on the desktop.'
  }
  return null
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

/** Plan and apply in one step, for callers with nothing to do in between. */
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

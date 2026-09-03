import { foldAgentEvent, type AgentTranscriptState } from '../../src/shared/agent-transcript'
import { parseRemoteChatServerMessage } from '../../src/shared/remote-chat'

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
 */

export type ChatConnectionPhase =
  /** No transcript yet; the first join (or a rejoin that lost the old state) is in flight. */
  | 'connecting'
  | 'live'
  /** The socket dropped; whatever transcript is shown is explicitly stale until the rejoin lands. */
  | 'reconnecting'
  /** The chat is no longer joinable: the desktop closed the node, or unlisted it. */
  | 'gone'

export interface ChatConnectionState {
  transcript: AgentTranscriptState | null
  phase: ChatConnectionPhase
}

export function initialChatConnectionState(): ChatConnectionState {
  return { transcript: null, phase: 'connecting' }
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
  if (message.type === 'snapshot') return { transcript: message.state, phase: 'live' }
  if (!state.transcript) return state
  return { ...state, transcript: foldAgentEvent(state.transcript, message.event, now) }
}

/**
 * The socket dropped. The transcript is kept for display - a phone that locked mid-turn should
 * come back to the conversation, not a blank screen - but the phase says out loud that it is
 * stale until the rejoin's snapshot replaces it.
 */
export function connectionLost(state: ChatConnectionState): ChatConnectionState {
  return { ...state, phase: state.transcript ? 'reconnecting' : 'connecting' }
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

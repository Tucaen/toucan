import type { AgentEvent } from './agent'
import type { AgentTranscriptState } from './agent-transcript'

/**
 * The wire contract for reading one chat live over the remote server's WebSocket route.
 *
 * The stream is snapshot-then-tail: on join the host sends the session's current transcript state,
 * and every subsequent message is one live `AgentEvent` the client folds through the same shared
 * reducer the desktop runs (`foldAgentEvent`). Events travel verbatim - there is no mobile DTO
 * layer - so every host derives an identical transcript from identical inputs.
 *
 * A snapshot is not only the first message: the host resends one whenever its own copy of the
 * transcript learned something the live tail did not carry (a provider replay folded during
 * `session/load`). A client therefore treats any snapshot as a full resync and replaces its state
 * wholesale, which is also what makes reconnect convergence trivial - rejoin, take the snapshot,
 * fold the tail; nothing is duplicated because nothing is ever merged.
 */
export type RemoteChatServerMessage =
  | { type: 'snapshot'; state: AgentTranscriptState }
  | { type: 'event'; event: AgentEvent }
  /**
   * The verdict on one `prompt` the client sent, correlated by its `requestId`. A send is never
   * assumed to have landed: the sent text only leaves the composer once the host says it started a
   * turn, and a refusal (busy session, dormant node, revoked token) comes back with the reason so
   * the phone can show it instead of losing what was typed. The message itself is *not* echoed
   * here - it reaches every client as the provider's own `user_message_chunk` event, so the phone
   * and the desktop render one message from one source rather than two optimistic copies.
   */
  | { type: 'prompt_result'; requestId: string; ok: boolean; message?: string }

/** What a paired client may ask the host to do on a chat socket. */
export type RemoteChatClientMessage = { type: 'prompt'; requestId: string; text: string }

/**
 * How much prompt text one frame may carry. A phone composer is not where a megabyte of pasted
 * context arrives, and this is a network surface, so the bound is stated once here: the client
 * refuses to send more, the host refuses to accept more, and `ws` is configured to drop a frame
 * that exceeds it before it is ever buffered.
 */
export const REMOTE_CHAT_PROMPT_LIMIT = 16_000

/**
 * Whether this text may be sent at all, and why not. Both ends run *this* function rather than
 * their own copy of the rule: the composer greys out its button with the same wording the host
 * would have refused it with, so a client and a host can never disagree about what is sendable.
 */
export function promptTextProblem(text: string): string | null {
  if (text.trim().length === 0) return 'Type a message first.'
  if (text.length > REMOTE_CHAT_PROMPT_LIMIT) return `A message may be at most ${REMOTE_CHAT_PROMPT_LIMIT} characters.`
  return null
}

/**
 * Parses one frame off the socket. Defensive on shape but not on depth: the payload comes from the
 * paired host (the same code base), so a recognizable envelope is trusted; anything else is
 * reported as null and skipped rather than crashing the fold.
 */
export function parseRemoteChatServerMessage(raw: unknown): RemoteChatServerMessage | null {
  if (typeof raw !== 'string') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const message = parsed as {
    type?: unknown
    state?: unknown
    event?: unknown
    requestId?: unknown
    ok?: unknown
    message?: unknown
  }
  if (message.type === 'snapshot' && message.state && typeof message.state === 'object') {
    return { type: 'snapshot', state: message.state as AgentTranscriptState }
  }
  if (message.type === 'event' && message.event && typeof message.event === 'object') {
    return { type: 'event', event: message.event as AgentEvent }
  }
  if (message.type === 'prompt_result' && typeof message.requestId === 'string' && typeof message.ok === 'boolean') {
    return {
      type: 'prompt_result',
      requestId: message.requestId,
      ok: message.ok,
      ...(typeof message.message === 'string' ? { message: message.message } : {})
    }
  }
  return null
}

/**
 * Parses one frame the *host* received. This direction is validated strictly, unlike the server
 * frames a client trusts: the sender is whoever holds the pairing token, and a frame that drives an
 * agent has to be exactly what it claims before it reaches the session. Anything unrecognized is
 * null, which the host answers with a refusal rather than by acting on a guess.
 */
export function parseRemoteChatClientMessage(raw: unknown): RemoteChatClientMessage | null {
  if (typeof raw !== 'string') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const message = parsed as { type?: unknown; requestId?: unknown; text?: unknown }
  if (message.type !== 'prompt') return null
  if (typeof message.requestId !== 'string' || message.requestId.length === 0) return null
  if (typeof message.text !== 'string') return null
  return { type: 'prompt', requestId: message.requestId, text: message.text }
}

/** The WebSocket route one chat is read on. The id is the canvas node id the chat list reported. */
export function remoteChatSocketPath(chatId: string): string {
  return `/api/chats/${encodeURIComponent(chatId)}`
}

/**
 * How a browser authenticates a WebSocket. The browser API cannot set an `Authorization` header on
 * the upgrade request, so the pairing token rides in the `Sec-WebSocket-Protocol` list instead -
 * still a header, never a URL, so it stays out of proxy logs and browser history exactly like the
 * bearer header does. The client offers two protocols: the real one, which the host accepts, and a
 * bearer entry the host consumes for authentication and never selects.
 */
export const REMOTE_CHAT_PROTOCOL = 'toucan.remote.v1'

const BEARER_PROTOCOL_PREFIX = 'toucan.bearer.'

export function remoteChatBearerProtocol(token: string): string {
  return `${BEARER_PROTOCOL_PREFIX}${token}`
}

/**
 * Reads the token back off the header the browser sent. Base64url tokens are valid HTTP token
 * characters, so no escaping is needed in either direction.
 */
export function tokenFromWebSocketProtocols(header: string | undefined): string | null {
  if (typeof header !== 'string') return null
  for (const entry of header.split(',')) {
    const candidate = entry.trim()
    if (candidate.startsWith(BEARER_PROTOCOL_PREFIX) && candidate.length > BEARER_PROTOCOL_PREFIX.length) {
      return candidate.slice(BEARER_PROTOCOL_PREFIX.length)
    }
  }
  return null
}

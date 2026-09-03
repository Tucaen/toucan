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
  { type: 'snapshot'; state: AgentTranscriptState } | { type: 'event'; event: AgentEvent }

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
  const message = parsed as { type?: unknown; state?: unknown; event?: unknown }
  if (message.type === 'snapshot' && message.state && typeof message.state === 'object') {
    return { type: 'snapshot', state: message.state as AgentTranscriptState }
  }
  if (message.type === 'event' && message.event && typeof message.event === 'object') {
    return { type: 'event', event: message.event as AgentEvent }
  }
  return null
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

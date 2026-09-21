import type { AgentDecisionResponseContent, AgentDecisionValue, AgentEvent } from './agent'
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
  /**
   * The verdict on one answer to a pending request - a tool permission or a structured question
   * set - correlated by its `requestId`. This is where losing a race is *reported* rather than
   * inferred: the host keys acceptance on the pending request's id, so exactly one client's answer
   * is acted on and every other one comes back `ok: false` with the reason. The resolution itself
   * still travels to every client as the session's own `approval_resolved`/`decision_resolved`
   * event, so a loser's card retires from the same source the winner's does.
   */
  | { type: 'answer_result'; requestId: string; ok: boolean; message?: string }
  /**
   * The verdict on one `set_model`, correlated by its `requestId`. Its own channel rather than a
   * shared one for the same reason an answer has one: a client that read a refused model change as
   * a refused prompt would put the wrong text back in its composer.
   *
   * The change itself is *not* reported here. It reaches every client as the session's own `models`
   * event, which is what makes a model picked on the phone and one picked on the desktop the same
   * single selection observed from two places rather than two copies that can drift.
   */
  | { type: 'model_result'; requestId: string; ok: boolean; message?: string }

/**
 * What a paired client may ask the host to do on a chat socket. Answering a pending request is a
 * separate message from a prompt on purpose: an answer is not free text, and letting it travel as
 * one would be exactly the bypass of the response channel both clients are forbidden.
 *
 * `requestId` correlates the verdict with the client that sent it and is minted per attempt;
 * `approvalId` / `decisionId` identify what is being answered and are the host's race key.
 */
export type RemoteChatClientMessage =
  | { type: 'prompt'; requestId: string; text: string }
  /** An omitted `optionId` is a cancellation, which is what the desktop's dismiss button sends. */
  | { type: 'approval'; requestId: string; approvalId: string; optionId?: string }
  /** Omitted `content` skips the question set, mirroring the desktop's "Skip". */
  | { type: 'decision'; requestId: string; decisionId: string; content?: AgentDecisionResponseContent }
  /**
   * "Run the rest of this conversation on that model." The id is one the session itself advertised
   * as `AgentModelState.availableModels`, which a client only has because the snapshot it already
   * holds carries it - so this frame names a choice the host published rather than one the client
   * invented. Whether that choice is takeable *right now* is deliberately not settled here: the
   * session manager owns it and refuses in its own words, exactly as it does for a prompt.
   */
  | { type: 'set_model'; requestId: string; modelId: string }
  /**
   * "I am looking at this chat." The one client frame with no `requestId` and no verdict, because
   * it is the one that asks for nothing back: the badge it retires is republished by the canvas in
   * the workspace projection the phone already polls, so the projection *is* the answer, and a read
   * that never landed is reissued by the next thing the reader watches settle.
   *
   * It names no kinds either. What a *view* clears is the canvas's `READ_ON_VIEW_KINDS` and stays
   * the canvas's decision - an approval must not be retired by being scrolled past, and letting a
   * phone name the kinds would be letting it answer a request by looking at it.
   */
  | { type: 'read' }

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
 * How large one structured answer may be. A form elicitation is a handful of fields with short
 * values, not a document, and the bounds are stated here so both ends agree - and so the whole
 * worst case still fits inside the frame size `ws` is configured to accept.
 */
export const REMOTE_CHAT_ANSWER_FIELD_LIMIT = 16
export const REMOTE_CHAT_ANSWER_VALUE_LIMIT = 2_000
/** How many options one multi-select question may carry an answer for. */
export const REMOTE_CHAT_ANSWER_OPTION_LIMIT = 32
/**
 * The whole answer's serialized size. Stated separately because the per-field bounds multiply out
 * to more than `ws` will accept, and a frame dropped at that layer gets no verdict - the one
 * outcome this protocol does not have. Kept comfortably inside the socket's `maxPayload`.
 */
export const REMOTE_CHAT_ANSWER_TOTAL_LIMIT = 32_000

/**
 * How long a model id one `set_model` frame may carry. Provider model ids are short slugs, so this
 * is headroom rather than a policy: the check that matters is that the id is one the session
 * actually advertised, and only the session manager can make that one.
 */
export const REMOTE_CHAT_MODEL_ID_LIMIT = 200

/**
 * Whether this answer may be sent at all, and why not. Same discipline as `promptTextProblem`:
 * the phone refuses it in the words the host would have refused it with, so a submit button and a
 * host verdict cannot disagree about what is answerable.
 */
export function decisionContentProblem(content: AgentDecisionResponseContent): string | null {
  const fields = Object.keys(content)
  // An empty answer is deliberately valid: a question set with nothing required may be accepted
  // with no fields, which is what the desktop's Submit does and is a different answer from Skip
  // (an accept with nothing said, rather than a cancellation).
  if (fields.length > REMOTE_CHAT_ANSWER_FIELD_LIMIT) {
    return `An answer may cover at most ${REMOTE_CHAT_ANSWER_FIELD_LIMIT} fields.`
  }
  for (const field of fields) {
    const value = content[field]
    const values = Array.isArray(value) ? value : [value]
    if (values.length > REMOTE_CHAT_ANSWER_OPTION_LIMIT) {
      return `An answer may select at most ${REMOTE_CHAT_ANSWER_OPTION_LIMIT} options.`
    }
    for (const entry of values) {
      if (typeof entry === 'string' && entry.length > REMOTE_CHAT_ANSWER_VALUE_LIMIT) {
        return `An answer may be at most ${REMOTE_CHAT_ANSWER_VALUE_LIMIT} characters.`
      }
      if (typeof entry === 'number' && !Number.isFinite(entry)) return 'That answer is not a number.'
    }
  }
  if (JSON.stringify(content).length > REMOTE_CHAT_ANSWER_TOTAL_LIMIT) return 'That answer is too large to send.'
  return null
}

/**
 * Reads one answer value off the wire. The four shapes are the whole of `AgentDecisionValue`, and
 * anything else - a nested object, a mixed array, a NaN that survived JSON - is null rather than
 * coerced: this value ends up inside an ACP elicitation response, so a guess here would be a guess
 * the agent acts on.
 */
function parseDecisionValue(raw: unknown): AgentDecisionValue | null {
  if (typeof raw === 'string' || typeof raw === 'boolean') return raw
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null
  if (Array.isArray(raw)) {
    return raw.every((entry) => typeof entry === 'string') ? (raw as string[]) : null
  }
  return null
}

function parseDecisionContent(raw: unknown): AgentDecisionResponseContent | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const content: AgentDecisionResponseContent = {}
  for (const [field, value] of Object.entries(raw as Record<string, unknown>)) {
    const parsed = parseDecisionValue(value)
    if (parsed === null) return null
    content[field] = parsed
  }
  return content
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
  if (
    (message.type === 'prompt_result' || message.type === 'answer_result' || message.type === 'model_result') &&
    typeof message.requestId === 'string' &&
    typeof message.ok === 'boolean'
  ) {
    return {
      type: message.type,
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
  const message = parsed as {
    type?: unknown
    requestId?: unknown
    text?: unknown
    approvalId?: unknown
    optionId?: unknown
    decisionId?: unknown
    content?: unknown
    modelId?: unknown
  }
  // Ahead of the correlation guard: a read is answered by nothing, so demanding a `requestId` for
  // it would refuse the frame over the one field it has no use for.
  if (message.type === 'read') return { type: 'read' }
  if (typeof message.requestId !== 'string' || message.requestId.length === 0) return null
  if (message.type === 'prompt') {
    if (typeof message.text !== 'string') return null
    return { type: 'prompt', requestId: message.requestId, text: message.text }
  }
  if (message.type === 'approval') {
    if (typeof message.approvalId !== 'string' || message.approvalId.length === 0) return null
    // A present-but-not-a-string option is a malformed frame, not a cancellation: reading it as
    // one would turn a version skew into a silently denied tool call.
    if (message.optionId !== undefined && typeof message.optionId !== 'string') return null
    if (typeof message.optionId === 'string' &&
      (message.optionId.length === 0 || message.optionId.length > REMOTE_CHAT_MODEL_ID_LIMIT)) return null
    return {
      type: 'approval',
      requestId: message.requestId,
      approvalId: message.approvalId,
      ...(typeof message.optionId === 'string' ? { optionId: message.optionId } : {})
    }
  }
  if (message.type === 'set_model') {
    // Bounded rather than trusted: this id ends up inside an ACP `session/set_config_option` call.
    // Membership in the session's advertised list is the session manager's check, not this one's.
    if (typeof message.modelId !== 'string') return null
    if (message.modelId.length === 0 || message.modelId.length > REMOTE_CHAT_MODEL_ID_LIMIT) return null
    return { type: 'set_model', requestId: message.requestId, modelId: message.modelId }
  }
  if (message.type === 'decision') {
    if (typeof message.decisionId !== 'string' || message.decisionId.length === 0) return null
    if (message.content === undefined) {
      return { type: 'decision', requestId: message.requestId, decisionId: message.decisionId }
    }
    const content = parseDecisionContent(message.content)
    if (!content) return null
    return { type: 'decision', requestId: message.requestId, decisionId: message.decisionId, content }
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

import { isFinalAssistantMessage } from './agent'
import type { AgentProvider } from './agent-provider'
import type { AgentChatStatus, AgentTranscriptState } from './agent-transcript'
import { isRecord } from './record'

/**
 * Sibling-session messaging (#2): one session asks another in the same project a question and gets
 * the answer back as a message of its own. v1 carries asks only. The main-process half is
 * `src/main/session-messenger.ts` (delivery, queueing, reply routing, limits, persistence); this
 * module is the vocabulary both halves and the canvas share, plus the words an agent reads.
 */

/** The two variables a session's adapter is launched with, beside `TOUCAN_NODE_ID`. */
export const MESSAGING_URL_ENV = 'TOUCAN_MESSAGING_URL'
export const MESSAGING_TOKEN_ENV = 'TOUCAN_MESSAGING_TOKEN'

/** Where the agent-facing skill and CLI live, below the Toucan skills root's `.agents`. */
export const SESSION_MESSAGING_SKILL_DIRECTORY = ['skills', 'session-messaging'] as const
export const SESSION_MESSAGING_CLI_PATH = [...SESSION_MESSAGING_SKILL_DIRECTORY, 'scripts', 'message.mjs'] as const

export const MESSAGING_COMMANDS = ['list', 'ask', 'reply'] as const
export type MessagingCommand = (typeof MESSAGING_COMMANDS)[number]

/** How many characters of a node id address a session: the length an outcome record's short id has. */
const SESSION_MESSAGING_SHORT_ID_LENGTH = 8

export function sessionMessagingShortId(nodeId: string): string {
  return nodeId.slice(0, SESSION_MESSAGING_SHORT_ID_LENGTH)
}

/** A text an agent may send: enough for a real question or answer, never a pasted log. */
export const SESSION_MESSAGE_TEXT_LIMIT = 8_000

export interface SessionMessagingSettings {
  /**
   * How deep a chain of questions may go: a session asked a question is one hop down, and its own
   * asks one further. A reply never deepens a chain - the turn it wakes asks at its asker's depth.
   */
  hopLimit: number
  /** How many asks one session may make in one turn. */
  asksPerTurn: number
}

export const DEFAULT_SESSION_MESSAGING_SETTINGS: SessionMessagingSettings = { hopLimit: 3, asksPerTurn: 5 }

const LIMIT_CEILING = 50

/**
 * The user's settings file, field by field: an absent field keeps its default, and one that is
 * present but not a whole number from 1 to 50 makes the whole file unusable - a typo must not
 * silently lift a safety limit. Null means unusable; the caller falls back to the defaults.
 */
export function parseSessionMessagingSettings(value: unknown): SessionMessagingSettings | null {
  if (!isRecord(value)) return null
  const settings = { ...DEFAULT_SESSION_MESSAGING_SETTINGS }
  for (const key of ['hopLimit', 'asksPerTurn'] as const) {
    const field = value[key]
    if (field === undefined) continue
    if (typeof field !== 'number' || !Number.isInteger(field) || field < 1 || field > LIMIT_CEILING) return null
    settings[key] = field
  }
  return settings
}

/**
 * What a reply is: the target's own `reply`, its final text when the question's turn ended without
 * one, or Toucan's word that no answer is coming because the target left the canvas.
 */
export type SessionReplyKind = 'reply' | 'implicit' | 'closed'

/** Why a message waits instead of starting a turn. */
export type SessionMessageQueueReason = 'busy' | 'waiting_on_human' | 'starting' | 'not_running'

/**
 * One message, as persisted and as the canvas sees it. An ask is open until it is answered (the
 * canvas's temporary edge); a reply lives only until it is delivered.
 */
export interface SessionMessage {
  id: string
  kind: 'ask' | 'reply'
  /** Sender and recipient node ids; a reply goes from the asked session back to the asker. */
  from: string
  to: string
  /** The two sessions' titles when the message was sent, so it can still name a closed node. */
  fromTitle: string
  toTitle: string
  text: string
  /** The ask's hop depth; a reply carries its ask's. */
  depth: number
  createdAt: string
  /** `dropped`: a reply whose asker left the canvas before it could be woken. Never persisted. */
  delivery: 'queued' | 'delivered' | 'dropped'
  queuedBecause?: SessionMessageQueueReason
  deliveredAt?: string
  /** Asks only: answered by a reply of any kind. */
  answered?: boolean
  /** Replies only. */
  askId?: string
  replyKind?: SessionReplyKind
}

export interface SessionMessageFile {
  version: 1
  messages: SessionMessage[]
}

const REPLY_KINDS: readonly string[] = ['reply', 'implicit', 'closed'] satisfies SessionReplyKind[]
const QUEUE_REASONS: readonly string[] = [
  'busy',
  'waiting_on_human',
  'starting',
  'not_running'
] satisfies SessionMessageQueueReason[]

function isSessionMessage(value: unknown): value is SessionMessage {
  if (!isRecord(value)) return false
  const strings = ['id', 'from', 'to', 'fromTitle', 'toTitle', 'text', 'createdAt'] as const
  if (!strings.every((key) => typeof value[key] === 'string')) return false
  if (value.kind !== 'ask' && value.kind !== 'reply') return false
  if (typeof value.depth !== 'number' || !Number.isInteger(value.depth) || value.depth < 1) return false
  // Only open messages are persisted: a dropped reply is never written.
  if (value.delivery !== 'queued' && value.delivery !== 'delivered') return false
  if (value.queuedBecause !== undefined && !QUEUE_REASONS.includes(value.queuedBecause as string)) return false
  if (value.kind === 'reply') return typeof value.askId === 'string' && REPLY_KINDS.includes(value.replyKind as string)
  return value.answered === undefined || typeof value.answered === 'boolean'
}

/** The persisted file, keeping every well-formed message: one damaged entry costs only itself. */
export function parseSessionMessageFile(value: unknown): SessionMessageFile | null {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.messages)) return null
  return { version: 1, messages: value.messages.filter(isSessionMessage) }
}

/** The live state of a session as delivery reads it. */
export interface MessagingSessionState {
  status: AgentChatStatus
  /** A tool-permission prompt or a provider-native question is waiting for the human. */
  waitingOnHuman: boolean
}

export type DeliveryVerdict = { deliver: true } | { deliver: false; reason: SessionMessageQueueReason }

/**
 * Whether a message may start a turn now. Only an idle session takes one: a busy session is never
 * steered, and a session waiting on the human keeps waiting - messaging answers no prompt of its.
 */
export function deliveryVerdict(state: MessagingSessionState | undefined): DeliveryVerdict {
  if (!state || state.status === 'exited') return { deliver: false, reason: 'not_running' }
  if (state.waitingOnHuman || state.status === 'auth_required') return { deliver: false, reason: 'waiting_on_human' }
  if (state.status === 'starting') return { deliver: false, reason: 'starting' }
  if (state.status === 'working') return { deliver: false, reason: 'busy' }
  return { deliver: true }
}

/** What the asker is told about a queued ask; the waiting-on-human wording is the settled one. */
export function queuedNote(reason: SessionMessageQueueReason): string {
  switch (reason) {
    case 'waiting_on_human':
      return 'queued: target waiting on human'
    case 'busy':
      return 'queued: target busy; delivered when its turn ends'
    case 'starting':
      return 'queued: target starting; delivered once it is ready'
    case 'not_running':
      return 'queued: target not running; delivered once it runs again'
  }
}

/** What a session is to messaging: chats and ticket sessions are targets, orchestrators only send. */
export type SessionMessagingRole = 'chat' | 'ticket' | 'orchestrator'

/** A sibling session as `list` shows it. */
export interface SessionMessagingListEntry {
  shortId: string
  title: string
  provider: AgentProvider
  role: SessionMessagingRole
  /** The orchestration ticket a ticket session works on. */
  ticketId?: string
  branch?: string
  state: 'idle' | 'working' | 'waiting_on_human' | 'starting' | 'not_running'
  /** When the session last did anything Toucan saw, ISO; absent when unknown. */
  updatedAt?: string
}

export function listState(state: MessagingSessionState | undefined): SessionMessagingListEntry['state'] {
  const verdict = deliveryVerdict(state)
  return verdict.deliver ? 'idle' : verdict.reason === 'busy' ? 'working' : verdict.reason
}

/**
 * The answer the turn that just ended gave: its last final assistant message after the latest user
 * message. Undefined when it gave none - a failed or cancelled turn, or one that only used tools.
 */
export function latestTurnAnswer(snapshot: Pick<AgentTranscriptState, 'messages'>): string | undefined {
  for (let index = snapshot.messages.length - 1; index >= 0; index -= 1) {
    const message = snapshot.messages[index]
    if (message === undefined) continue
    if (message.role === 'user') return undefined
    if (isFinalAssistantMessage(message) && message.text.trim()) return message.text.trim()
  }
  return undefined
}

/** Who a delivered message names. */
export interface SessionMessageParty {
  shortId: string
  title: string
}

const quoted = (title: string): string => JSON.stringify(title)

/**
 * The prompt an ask starts in its target. The header is what the agent and the canvas recognise a
 * message by; the footer is the whole reply protocol, so a target that never read the skill still
 * knows what to do.
 */
export function askPrompt(message: Pick<SessionMessage, 'id' | 'text'>, sender: SessionMessageParty): string {
  return [
    `[Toucan message ${message.id} from session ${sender.shortId} ${quoted(sender.title)}]`,
    message.text,
    '',
    `Answer with the session-messaging CLI: reply --id ${message.id} --text <answer>. ` +
      'If this turn ends without a reply, your final message is sent back as an implicit reply.'
  ].join('\n')
}

/** The prompt that wakes an asker with an answer, or with Toucan's word that none is coming. */
export function replyPrompt(
  reply: Pick<SessionMessage, 'askId' | 'text' | 'replyKind'>,
  sender: SessionMessageParty
): string {
  const from = `session ${sender.shortId} ${quoted(sender.title)}`
  switch (reply.replyKind) {
    case 'implicit':
      return `[Toucan implicit reply to your message ${reply.askId} from ${from}: its turn ended without a reply, so this is its final message]\n${reply.text}`
    case 'closed':
      return `[Toucan: no reply to your message ${reply.askId}]\n${reply.text}`
    default:
      return `[Toucan reply to your message ${reply.askId} from ${from}]\n${reply.text}`
  }
}

/** What an implicit reply says when the turn gave no final message at all. */
export function noAnswerText(ending: { type: string; message?: string }): string {
  if (ending.type === 'turn_failed')
    return `(no final message: the turn failed: ${ending.message ?? 'no reason given'})`
  if (ending.type === 'turn_cancelled') return '(no final message: the turn was cancelled)'
  return '(no final message)'
}

/** The notice an asker gets when its target is gone; the settled wording leads. */
export function targetClosedText(target: SessionMessageParty): string {
  return `target closed; use session-records. Session ${target.shortId} ${quoted(target.title)} left the canvas before answering; its outcome record says what it did.`
}

/** The refusal for a target that is not running; it points at what can still answer. */
export function notRunningRefusal(target: SessionMessageParty): string {
  return `session ${target.shortId} ${quoted(target.title)} is not running, so it cannot be asked; use session-records for what it did`
}

/** What every chat, ticket and orchestrator session carries on its system prompt. */
export function sessionMessagingInstruction(cliPath: string): string {
  const cli = `node "${cliPath}"`
  return [
    `You can message sibling agent sessions of this project with \`${cli} list\`, \`${cli} ask --to <shortId> --text <question>\` and \`${cli} reply --id <messageId> --text <answer>\`; each prints one JSON line.`,
    'Prefer session-records and git for past facts - what a session did, touched or failed on; message a session only for intent, plans and live state that no record holds.',
    'ask returns at once: never wait or poll for the answer, which arrives later as a new message that starts a turn of yours. End your turn instead.',
    'When a message reaches you, answer it with reply; if you end that turn without replying, your final message goes back as an implicit reply.',
    'Messaging never answers permission prompts. Question chains are limited in depth and in asks per turn; a refused ask is shown to the human.'
  ].join(' ')
}

/**
 * What the canvas hears (#3 renders it): every message as it is created or changes - sent, queued,
 * delivered, answered, dropped - and every refusal the human should see.
 */
export type SessionMessagingEvent =
  { type: 'message'; message: SessionMessage } | { type: 'notice'; nodeId: string; text: string; at: string }

/** The canvas's reach into messaging: read-only, since no message waits on a human's approval. */
export interface SessionMessagingApi {
  /** Every open message - queued ones and asks still waiting for an answer - for a canvas joining late. */
  open(): Promise<SessionMessage[]>
  onEvent(listener: (event: SessionMessagingEvent) => void): () => void
}

import type { Edge } from '@xyflow/react'
import { LINEAGE_SOURCE_HANDLE, LINEAGE_TARGET_HANDLE } from './conversation-lineage'
import {
  queuedNote,
  sessionMessagingShortId,
  type SessionMessage,
  type SessionMessagingEvent
} from '../../shared/session-messaging'

/**
 * What the canvas shows of sibling-session messaging (#3): labelled entries in both sessions'
 * chats, a temporary edge while an ask is open, and the notices for refused asks. Everything here
 * is a projection of the events main publishes (`SessionMessagingEvent`); nothing is stored, so a
 * restart rebuilds it from `open()` and the edge returns exactly as long as the ask stays open.
 */

export const MESSAGING_EDGE_CLASS = 'messaging-edge'

/** Notices a window keeps: a refusal is for the human to read once, not to accumulate forever. */
const NOTICE_LIMIT = 20

export interface SessionMessagingNotice {
  key: string
  nodeId: string
  text: string
  at: string
}

export interface SessionMessagingView {
  messages: ReadonlyMap<string, SessionMessage>
  notices: readonly SessionMessagingNotice[]
}

export const EMPTY_MESSAGING_VIEW: SessionMessagingView = { messages: new Map(), notices: [] }

/**
 * A message event replaces the message of that id; a notice is appended. Events are the live
 * truth: an `open()` result that arrives late is merged under them, never over them.
 */
export function applyMessagingEvent(view: SessionMessagingView, event: SessionMessagingEvent): SessionMessagingView {
  if (event.type === 'notice') {
    const notice = {
      key: `${event.nodeId}@${event.at}:${view.notices.length}`,
      nodeId: event.nodeId,
      text: event.text,
      at: event.at
    }
    return { messages: view.messages, notices: [...view.notices, notice].slice(-NOTICE_LIMIT) }
  }
  const messages = new Map(view.messages)
  messages.set(event.message.id, event.message)
  return { messages, notices: view.notices }
}

/** The late `open()` result under whatever live events already arrived. */
export function mergeOpenMessages(view: SessionMessagingView, open: readonly SessionMessage[]): SessionMessagingView {
  const messages = new Map(open.map((message) => [message.id, message]))
  for (const [id, message] of view.messages) messages.set(id, message)
  return { messages, notices: view.notices }
}

export function dismissNotice(view: SessionMessagingView, key: string): SessionMessagingView {
  return { messages: view.messages, notices: view.notices.filter((notice) => notice.key !== key) }
}

export type MessagingEntryTone = 'ask' | 'reply' | 'implicit' | 'closed' | 'dropped'

/** One labelled line in a session's chat. */
export interface SessionMessagingEntry {
  key: string
  messageId: string
  at: string
  tone: MessagingEntryTone
  /** "Question to ...", "Reply from ..." - which way, and with whom. */
  label: string
  text: string
  /** Queued, unanswered or undeliverable, in words; absent when there is nothing left to say. */
  status?: string
}

function party(title: string, nodeId: string): string {
  return `${title} (${sessionMessagingShortId(nodeId)})`
}

function entryFor(message: SessionMessage, nodeId: string): SessionMessagingEntry | undefined {
  const sent = message.from === nodeId
  if (!sent && message.to !== nodeId) return undefined
  const base = {
    key: `${message.id}:${sent ? 'out' : 'in'}`,
    messageId: message.id,
    at: message.createdAt,
    text: message.text
  }
  const other = sent ? party(message.toTitle, message.to) : party(message.fromTitle, message.from)
  const queued =
    message.delivery === 'queued' ? (message.queuedBecause ? queuedNote(message.queuedBecause) : 'queued') : undefined
  if (message.kind === 'ask') {
    const status = queued ?? (message.answered ? undefined : 'awaiting a reply')
    return { ...base, tone: 'ask', label: sent ? `Question to ${other}` : `Question from ${other}`, status }
  }
  const dropped = message.delivery === 'dropped' ? 'not delivered: the asker left the canvas' : undefined
  const status = dropped ?? queued
  switch (message.replyKind) {
    case 'implicit':
      return {
        ...base,
        tone: 'implicit',
        label: sent ? `Implicit reply to ${other}` : `Implicit reply from ${other}`,
        status
      }
    case 'closed':
      // Toucan's own word, not the target's: nobody sent it, so it names the target that left.
      return { ...base, tone: 'closed', label: `No reply: ${other} left the canvas`, status }
    default:
      return {
        ...base,
        tone: dropped ? 'dropped' : 'reply',
        label: sent ? `Reply to ${other}` : `Reply from ${other}`,
        status
      }
  }
}

/** Every message this session sent or received, oldest first. */
export function messagingEntriesFor(view: SessionMessagingView, nodeId: string): SessionMessagingEntry[] {
  return [...view.messages.values()]
    .flatMap((message) => entryFor(message, nodeId) ?? [])
    .sort((a, b) => a.at.localeCompare(b.at) || a.key.localeCompare(b.key))
}

export function messagingNoticesFor(view: SessionMessagingView, nodeId: string): SessionMessagingNotice[] {
  return view.notices.filter((notice) => notice.nodeId === nodeId)
}

/** An ask is open from the moment it is sent until a reply of any kind answers it. */
function isOpenAsk(message: SessionMessage): boolean {
  return message.kind === 'ask' && !message.answered && message.delivery !== 'dropped'
}

/** @internal exported for tests */
export function messagingEdgeId(askId: string): string {
  return `messaging:${askId}`
}

/** What the projection depends on, so a drag does not mint fresh edges per frame (see `lineageKey`). */
export function messagingKey(view: SessionMessagingView): string {
  return [...view.messages.values()]
    .filter(isOpenAsk)
    .map((message) => message.id)
    .join('|')
}

/**
 * One temporary edge per open ask, from asker to asked. It is drawn only while both ends are on
 * the canvas and goes the moment the ask is answered. Like the lineage edge it is not selectable,
 * deletable or connectable and grants nothing; a chain of asks draws one edge per open ask.
 */
export function messagingEdges(view: SessionMessagingView, presentNodeIds: ReadonlySet<string>): Edge[] {
  return [...view.messages.values()].filter(isOpenAsk).flatMap((message) =>
    message.from === message.to || !presentNodeIds.has(message.from) || !presentNodeIds.has(message.to)
      ? []
      : [
          {
            id: messagingEdgeId(message.id),
            source: message.from,
            target: message.to,
            sourceHandle: LINEAGE_SOURCE_HANDLE,
            targetHandle: LINEAGE_TARGET_HANDLE,
            className: MESSAGING_EDGE_CLASS,
            animated: true,
            selectable: false,
            deletable: false,
            reconnectable: false,
            focusable: false
          }
        ]
  )
}

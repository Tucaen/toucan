import { describe, expect, test } from 'vitest'
import {
  applyMessagingEvent,
  dismissNotice,
  EMPTY_MESSAGING_VIEW,
  mergeOpenMessages,
  messagingEdgeId,
  messagingEdges,
  messagingEntriesFor,
  messagingKey,
  messagingNoticesFor,
  type SessionMessagingView
} from '../src/renderer/src/session-messaging-view'
import type { SessionMessage } from '../src/shared/session-messaging'

// The canvas half of sibling-session messaging (#3): entries per session, the temporary edge while
// an ask is open, and the refusal notice. Everything is a projection of main's events.

const A = 'aaaaaaaa-1111'
const B = 'bbbbbbbb-2222'

function ask(overrides: Partial<SessionMessage> = {}): SessionMessage {
  return {
    id: 'm1',
    kind: 'ask',
    from: A,
    to: B,
    fromTitle: 'Alpha',
    toTitle: 'Beta',
    text: 'Which port?',
    depth: 1,
    createdAt: '2026-10-25T10:00:00.000Z',
    delivery: 'delivered',
    ...overrides
  }
}

function reply(overrides: Partial<SessionMessage> = {}): SessionMessage {
  return ask({
    id: 'm2',
    kind: 'reply',
    from: B,
    to: A,
    fromTitle: 'Beta',
    toTitle: 'Alpha',
    text: '8080',
    askId: 'm1',
    replyKind: 'reply',
    createdAt: '2026-10-25T10:01:00.000Z',
    ...overrides
  })
}

const send = (view: SessionMessagingView, message: SessionMessage): SessionMessagingView =>
  applyMessagingEvent(view, { type: 'message', message })

describe('entries', () => {
  test('an ask is labelled for its asker and for its target, in both chats', () => {
    const view = send(EMPTY_MESSAGING_VIEW, ask())
    const [sent] = messagingEntriesFor(view, A)
    const [received] = messagingEntriesFor(view, B)
    expect(sent).toMatchObject({ tone: 'ask', label: 'Question to Beta (bbbbbbbb)', text: 'Which port?' })
    expect(received).toMatchObject({ tone: 'ask', label: 'Question from Alpha (aaaaaaaa)' })
    expect(messagingEntriesFor(view, 'cccccccc')).toEqual([])
  })

  test('a reply shows in both chats, after its ask', () => {
    const view = send(send(EMPTY_MESSAGING_VIEW, reply()), ask({ answered: true }))
    expect(messagingEntriesFor(view, A).map((entry) => entry.label)).toEqual([
      'Question to Beta (bbbbbbbb)',
      'Reply from Beta (bbbbbbbb)'
    ])
    expect(messagingEntriesFor(view, B).map((entry) => entry.label)).toEqual([
      'Question from Alpha (aaaaaaaa)',
      'Reply to Alpha (aaaaaaaa)'
    ])
  })

  test('an event for a known message replaces it rather than adding another entry', () => {
    const view = send(send(EMPTY_MESSAGING_VIEW, ask({ delivery: 'queued', queuedBecause: 'busy' })), ask())
    expect(messagingEntriesFor(view, A)).toHaveLength(1)
  })

  test('an implicit reply is marked as one', () => {
    const view = send(EMPTY_MESSAGING_VIEW, reply({ replyKind: 'implicit' }))
    expect(messagingEntriesFor(view, A)[0]).toMatchObject({
      tone: 'implicit',
      label: 'Implicit reply from Beta (bbbbbbbb)'
    })
  })

  test('the target-closed word names the target that left, not a sender', () => {
    const view = send(EMPTY_MESSAGING_VIEW, reply({ replyKind: 'closed', text: 'target closed; use session-records.' }))
    expect(messagingEntriesFor(view, A)[0]).toMatchObject({
      tone: 'closed',
      label: 'No reply: Beta (bbbbbbbb) left the canvas'
    })
  })

  test('a queued ask carries the settled reason, and an unanswered one says it awaits a reply', () => {
    const queued = send(EMPTY_MESSAGING_VIEW, ask({ delivery: 'queued', queuedBecause: 'waiting_on_human' }))
    expect(messagingEntriesFor(queued, A)[0]?.status).toBe('queued: target waiting on human')
    expect(messagingEntriesFor(send(EMPTY_MESSAGING_VIEW, ask()), A)[0]?.status).toBe('awaiting a reply')
    expect(messagingEntriesFor(send(EMPTY_MESSAGING_VIEW, ask({ answered: true })), A)[0]?.status).toBeUndefined()
  })

  test('a dropped reply says it was not delivered', () => {
    const view = send(EMPTY_MESSAGING_VIEW, reply({ delivery: 'dropped' }))
    expect(messagingEntriesFor(view, B)[0]).toMatchObject({
      tone: 'dropped',
      status: 'not delivered: the asker left the canvas'
    })
  })
})

describe('edge lifecycle', () => {
  const present = new Set([A, B])

  test('an open ask draws one edge from asker to asked; answering it removes the edge', () => {
    let view = send(EMPTY_MESSAGING_VIEW, ask())
    expect(messagingEdges(view, present)).toMatchObject([{ id: messagingEdgeId('m1'), source: A, target: B }])
    expect(messagingKey(view)).toBe('m1')
    view = send(view, ask({ answered: true }))
    expect(messagingEdges(view, present)).toEqual([])
    expect(messagingKey(view)).toBe('')
  })

  test('a queued ask already draws the edge: the exchange is open', () => {
    const view = send(EMPTY_MESSAGING_VIEW, ask({ delivery: 'queued', queuedBecause: 'busy' }))
    expect(messagingEdges(view, present)).toHaveLength(1)
  })

  test('replies draw nothing, and an edge needs both nodes on the canvas', () => {
    expect(messagingEdges(send(EMPTY_MESSAGING_VIEW, reply()), present)).toEqual([])
    expect(messagingEdges(send(EMPTY_MESSAGING_VIEW, ask()), new Set([A]))).toEqual([])
  })

  test('the edge cannot be selected, removed or reconnected by hand', () => {
    const [edge] = messagingEdges(send(EMPTY_MESSAGING_VIEW, ask()), present)
    expect(edge).toMatchObject({ selectable: false, deletable: false, reconnectable: false, focusable: false })
  })

  test('open asks seeded by open() draw an edge after a restart; live events win over a late open()', () => {
    const merged = mergeOpenMessages(send(EMPTY_MESSAGING_VIEW, ask({ answered: true })), [ask()])
    expect(messagingEdges(merged, present)).toEqual([])
    expect(messagingEdges(mergeOpenMessages(EMPTY_MESSAGING_VIEW, [ask()]), present)).toHaveLength(1)
  })
})

describe('refusal notice', () => {
  const notice = {
    type: 'notice',
    nodeId: A,
    text: 'Message refused: hop limit reached',
    at: '2026-10-25T10:02:00.000Z'
  } as const

  test('a notice shows for the session it names only, and can be dismissed', () => {
    let view = applyMessagingEvent(EMPTY_MESSAGING_VIEW, notice)
    expect(messagingNoticesFor(view, A)).toHaveLength(1)
    expect(messagingNoticesFor(view, B)).toEqual([])
    view = dismissNotice(view, messagingNoticesFor(view, A)[0]!.key)
    expect(messagingNoticesFor(view, A)).toEqual([])
  })

  test('two identical refusals are two notices', () => {
    const view = applyMessagingEvent(applyMessagingEvent(EMPTY_MESSAGING_VIEW, notice), notice)
    expect(new Set(messagingNoticesFor(view, A).map((entry) => entry.key)).size).toBe(2)
  })
})

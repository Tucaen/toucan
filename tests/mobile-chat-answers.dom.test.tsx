import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import ChatScreen from '../mobile/src/ChatScreen'
import type { SavedHost } from '../mobile/src/hosts'
import type { AgentEvent } from '../src/shared/agent'
import { foldAgentEvent, initialAgentTranscriptState } from '../src/shared/agent-transcript'
import type { RemoteChatSummary } from '../src/shared/remote-access'
import type { RemoteChatServerMessage } from '../src/shared/remote-chat'

/**
 * The phone's answer surface, rendered. What is worth a DOM test here is exactly what a pure
 * reducer cannot state: that the composer is *gone* while a request stands (not merely disabled,
 * which would still invite typing past the request), that the option set the agent sent is what
 * the reader taps, and that a typed answer leaves as one structured frame.
 *
 * The socket is a stub rather than a server: this file is about what the screen does with frames
 * and taps. `tests/remote-server.test.ts` covers what the host does with the frames it produces.
 */

class StubSocket {
  static instances: StubSocket[] = []
  static readonly OPEN = 1
  readyState = StubSocket.OPEN
  sent: string[] = []
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: (() => void) | null = null

  constructor(
    readonly url: string,
    readonly protocols?: string[]
  ) {
    StubSocket.instances.push(this)
  }

  send(raw: string): void {
    this.sent.push(raw)
  }

  close(): void {
    this.readyState = 3
  }

  /** The last thing the phone put on the wire, parsed. */
  lastSent(): Record<string, unknown> {
    return JSON.parse(this.sent[this.sent.length - 1]) as Record<string, unknown>
  }
}

const HOST: SavedHost = { id: 'host-1', name: 'Work PC', origin: 'http://work-pc:1789', token: 'token' }

const SUMMARY: RemoteChatSummary = {
  id: 'chat-1',
  kind: 'claude',
  title: 'Fix the parser',
  projectId: 'toucan',
  status: 'working',
  unread: 0
}

const APPROVAL: AgentEvent = {
  type: 'approval',
  approvalId: 'p1',
  title: 'Run command: npm test',
  options: [
    { id: 'allow', label: 'Allow once', kind: 'allow_once' },
    { id: 'reject', label: 'Reject', kind: 'reject_once' }
  ]
}

const QUESTIONS: AgentEvent = {
  type: 'decision_request',
  request: {
    id: 'd1',
    message: 'Please answer the following questions.',
    questions: [
      {
        id: 'scope',
        title: 'Scope',
        question: 'Read-only first?',
        options: [
          { value: 'Read-only', label: 'Read-only' },
          { value: 'Complete CRUD', label: 'Complete CRUD' }
        ],
        input: 'select',
        multiSelect: false,
        required: true
      },
      {
        id: 'areas',
        title: 'Areas',
        question: 'Which areas?',
        options: [
          { value: 'ui', label: 'UI' },
          { value: 'api', label: 'API' }
        ],
        input: 'select',
        multiSelect: true
      },
      { id: 'note', title: 'Note', question: 'Anything else?', options: [], input: 'text', multiSelect: false }
    ]
  }
}

function snapshotFrame(events: readonly AgentEvent[]): RemoteChatServerMessage {
  return {
    type: 'snapshot',
    state: events.reduce(
      (state, event) => foldAgentEvent(state, event, 1_700_000_000_000),
      initialAgentTranscriptState()
    )
  }
}

/** Renders the screen with an open socket and the host's first frame already delivered. */
function open(events: readonly AgentEvent[]): StubSocket {
  render(<ChatScreen host={HOST} chatId="chat-1" summary={SUMMARY} onBack={() => {}} onUnauthorized={() => {}} />)
  const socket = StubSocket.instances[0]
  act(() => {
    socket.onopen?.()
    socket.onmessage?.({ data: JSON.stringify(snapshotFrame(events)) })
  })
  return socket
}

function deliver(socket: StubSocket, message: RemoteChatServerMessage): void {
  act(() => socket.onmessage?.({ data: JSON.stringify(message) }))
}

beforeEach(() => {
  StubSocket.instances = []
  // jsdom has no layout, so the transcript's tail-following call has nothing to do here.
  Element.prototype.scrollIntoView = () => {}
  vi.stubGlobal('WebSocket', StubSocket)
  // Only reached if the socket drops, which no test here does; a rejection would be a real failure.
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('no host in this test')))
  window.localStorage.clear()
})

describe('answering a tool permission from the phone', () => {
  test('the composer is replaced by the request, and the tapped option leaves as one frame', () => {
    const socket = open([{ type: 'status', status: 'working' }, APPROVAL])

    expect(screen.getByText('Run command: npm test')).toBeInTheDocument()
    // Not a disabled composer: there is nothing to type into while the agent waits on an answer.
    expect(screen.queryByLabelText('Message')).not.toBeInTheDocument()
    expect(screen.getByText('Needs you')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Allow once' }))
    expect(socket.lastSent()).toMatchObject({ type: 'approval', approvalId: 'p1', optionId: 'allow' })

    // Answered but not yet confirmed: the options go dead so a second tap cannot answer twice.
    expect(screen.getByRole('button', { name: 'Reject' })).toBeDisabled()
  })

  test('dismissing sends a cancellation rather than an option the agent never offered', () => {
    const socket = open([APPROVAL])
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    const sent = socket.lastSent()
    expect(sent).toMatchObject({ type: 'approval', approvalId: 'p1' })
    expect(sent.optionId).toBeUndefined()
  })

  test('losing the race says so, and the card retires when the resolution arrives', () => {
    const socket = open([APPROVAL])
    fireEvent.click(screen.getByRole('button', { name: 'Allow once' }))
    const requestId = socket.lastSent().requestId as string

    deliver(socket, {
      type: 'answer_result',
      requestId,
      ok: false,
      message: 'That request was already answered.'
    })
    expect(screen.getByRole('alert')).toHaveTextContent('That request was already answered.')

    // The winner's answer reaches every client as the session's own event; the card goes with it
    // and the composer comes back.
    deliver(socket, { type: 'event', event: { type: 'approval_resolved', approvalId: 'p1' } })
    expect(screen.queryByText('Run command: npm test')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Message')).toBeInTheDocument()
  })
})

describe('answering a structured question set from the phone', () => {
  test('select, multi-select and text answers submit as one response', () => {
    const socket = open([QUESTIONS])

    expect(screen.getByText('Please answer the following questions.')).toBeInTheDocument()
    expect(screen.queryByLabelText('Message')).not.toBeInTheDocument()

    // A single-value choice advances to the next question on its own: one screen, one decision.
    fireEvent.click(screen.getByRole('button', { name: 'Read-only' }))
    expect(screen.getByText('Which areas?')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'UI' }))
    fireEvent.click(screen.getByRole('button', { name: 'API' }))
    // A multi-select stays put while the reader keeps adding to it.
    expect(screen.getByRole('button', { name: 'UI' })).toHaveAttribute('aria-pressed', 'true')

    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    fireEvent.change(screen.getByLabelText('Anything else?'), { target: { value: 'be careful' } })

    fireEvent.click(screen.getByRole('button', { name: 'Submit answers' }))
    expect(socket.lastSent()).toMatchObject({
      type: 'decision',
      decisionId: 'd1',
      content: { scope: 'Read-only', areas: ['ui', 'api'], note: 'be careful' }
    })
  })

  test('a required answer gates submission, and skipping is a separate answer', () => {
    const socket = open([QUESTIONS])
    expect(screen.getByRole('button', { name: 'Submit answers' })).toBeDisabled()
    expect(screen.getByText(/1 required answer remaining/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Skip' }))
    const sent = socket.lastSent()
    expect(sent).toMatchObject({ type: 'decision', decisionId: 'd1' })
    expect(sent.content).toBeUndefined()
  })
})

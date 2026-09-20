import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import ChatScreen from '../mobile/src/ChatScreen'
import type { SavedHost } from '../mobile/src/hosts'
import { MODEL_CHANGE_WHILE_BUSY, type AgentEvent } from '../src/shared/agent'
import { foldAgentEvent, initialAgentTranscriptState } from '../src/shared/agent-transcript'
import type { RemoteChatSummary } from '../src/shared/remote-access'
import type { RemoteChatServerMessage } from '../src/shared/remote-chat'

/**
 * The phone's model surface, rendered. The reducer states the rules; what is worth a DOM test is
 * the half a pure function cannot show - that the model is on screen *before* anything is sent
 * (the worse half of the reported bug was not knowing what is about to run), that a pick leaves as
 * one `set_model` frame, and that the displayed selection only ever moves on the session's own
 * `models` event, never on the tap or on the acceptance of it.
 *
 * The socket is a stub; `tests/remote-server.test.ts` covers what the host does with these frames.
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
  status: 'idle',
  unread: 0
}

const AVAILABLE = [
  { id: 'sonnet', name: 'Sonnet' },
  { id: 'opus', name: 'Opus' }
]

const MODELS: AgentEvent = { type: 'models', models: { currentModelId: 'sonnet', availableModels: AVAILABLE } }

const IDLE: AgentEvent = { type: 'status', status: 'idle' }

function snapshotFrame(events: readonly AgentEvent[]): RemoteChatServerMessage {
  return {
    type: 'snapshot',
    state: events.reduce(
      (state, event) => foldAgentEvent(state, event, 1_700_000_000_000),
      initialAgentTranscriptState()
    )
  }
}

function open(events: readonly AgentEvent[]): StubSocket {
  render(
    <ChatScreen
      host={HOST}
      chatId="chat-1"
      summary={SUMMARY}
      rateLimits={{}}
      onBack={() => {}}
      onUnauthorized={() => {}}
    />
  )
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

/** The model control, as the reader sees it. */
function picker(): HTMLSelectElement {
  return screen.getByLabelText('Model') as HTMLSelectElement
}

beforeEach(() => {
  StubSocket.instances = []
  Element.prototype.scrollIntoView = () => {}
  vi.stubGlobal('WebSocket', StubSocket)
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('no host in this test')))
  window.localStorage.clear()
})

describe('seeing and choosing the model from the phone', () => {
  test('the current model is on screen from the snapshot alone, with the rest offered', () => {
    open([IDLE, MODELS])

    expect(picker().value).toBe('sonnet')
    expect([...picker().options].map((option) => option.textContent)).toEqual(['Sonnet', 'Opus'])
  })

  test('a session that advertises no model choice shows no picker rather than an empty one', () => {
    open([IDLE])
    expect(screen.queryByLabelText('Model')).not.toBeInTheDocument()
  })

  test('a pick leaves as one set_model frame and the control goes inert until it is answered', () => {
    const socket = open([IDLE, MODELS])

    fireEvent.change(picker(), { target: { value: 'opus' } })
    expect(socket.lastSent()).toMatchObject({ type: 'set_model', modelId: 'opus' })

    // Asked for, not applied: the control still reports what the conversation is running on.
    expect(picker()).toBeDisabled()
    expect(picker().value).toBe('sonnet')
    expect(screen.getByText('Switching…')).toBeInTheDocument()
  })

  test('the selection moves on the session event, not on the verdict that accepted it', () => {
    const socket = open([IDLE, MODELS])
    fireEvent.change(picker(), { target: { value: 'opus' } })
    const requestId = socket.lastSent().requestId as string

    deliver(socket, { type: 'model_result', requestId, ok: true })
    expect(picker()).not.toBeDisabled()
    expect(picker().value).toBe('sonnet')

    deliver(socket, {
      type: 'event',
      event: { type: 'models', models: { currentModelId: 'opus', availableModels: AVAILABLE } }
    })
    expect(picker().value).toBe('opus')
  })

  test('a model change the desktop made is what the phone shows, with nothing sent from here', () => {
    const socket = open([IDLE, MODELS])
    deliver(socket, {
      type: 'event',
      event: { type: 'models', models: { currentModelId: 'opus', availableModels: AVAILABLE } }
    })

    expect(picker().value).toBe('opus')
    expect(socket.sent.filter((raw) => raw.includes('set_model'))).toEqual([])
  })

  test('a refusal is reported where the pick was made, and the picker re-opens', () => {
    const socket = open([IDLE, MODELS])
    fireEvent.change(picker(), { target: { value: 'opus' } })
    const requestId = socket.lastSent().requestId as string

    deliver(socket, {
      type: 'model_result',
      requestId,
      ok: false,
      message: 'This agent does not expose model selection.'
    })
    expect(screen.getByRole('alert')).toHaveTextContent('This agent does not expose model selection.')
    expect(picker()).not.toBeDisabled()
  })

  test('a turn in flight closes the picker and says why', () => {
    open([MODELS, { type: 'status', status: 'working' }])
    expect(picker().value).toBe('sonnet')
    expect(picker()).toBeDisabled()
    // The reason is readable rather than a silently dead control, and it is the host's own wording.
    expect(screen.getByText(MODEL_CHANGE_WHILE_BUSY)).toBeInTheDocument()
  })

  test('an exited session shows what it ran on but offers no change', () => {
    open([MODELS, { type: 'status', status: 'exited' }])
    expect(picker().value).toBe('sonnet')
    expect(picker()).toBeDisabled()
  })

  test('the model stays readable while a pending request has taken the composer away', () => {
    open([
      MODELS,
      {
        type: 'approval',
        approvalId: 'p1',
        title: 'Run command: npm test',
        options: [{ id: 'allow', label: 'Allow once', kind: 'allow_once' }]
      }
    ])

    expect(screen.queryByLabelText('Message')).not.toBeInTheDocument()
    expect(picker().value).toBe('sonnet')
  })
})

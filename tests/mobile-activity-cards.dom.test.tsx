import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import ChatScreen from '../mobile/src/ChatScreen'
import type { SavedHost } from '../mobile/src/hosts'
import type { AgentEvent } from '../src/shared/agent'
import { foldAgentEvent, initialAgentTranscriptState } from '../src/shared/agent-transcript'
import type { RemoteChatServerMessage } from '../src/shared/remote-chat'
import { slimTranscriptState } from '../src/shared/remote-activity'

/**
 * A tool card on the phone, rendered. The transcript carries only a slim copy of each call, so the
 * rules worth a DOM test are the ones a pure function cannot show: that a card says what it has
 * (summary and preview) with nothing sent, that opening it is one `activity` frame, that the body
 * appears only from the host's verdict, and that closing it forgets the body.
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

  frames(type: string): Record<string, unknown>[] {
    return this.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>).filter((frame) => frame.type === type)
  }
}

const HOST: SavedHost = { id: 'host-1', name: 'Work PC', origin: 'http://work-pc:1789', token: 'token' }

const FULL_CALL: AgentEvent = {
  type: 'activity',
  activity: {
    id: 'call-1',
    title: 'Run the tests',
    kind: 'execute',
    status: 'completed',
    rawInput: { command: 'npm test' },
    terminalOutput: `${'noise\n'.repeat(200)}PASS all 12 suites`
  }
}

function open(): StubSocket {
  render(
    <ChatScreen
      host={HOST}
      chatId="chat-1"
      summary={null}
      rateLimits={{}}
      onBack={() => {}}
      onUnauthorized={() => {}}
    />
  )
  const socket = StubSocket.instances[0]
  // What the host sends: the snapshot already cut down, exactly as `attachChatSocket` does.
  const state = slimTranscriptState(foldAgentEvent(initialAgentTranscriptState(), FULL_CALL, 1_700_000_000_000))
  act(() => {
    socket.onopen?.()
    socket.onmessage?.({ data: JSON.stringify({ type: 'snapshot', state } satisfies RemoteChatServerMessage) })
  })
  return socket
}

function deliver(socket: StubSocket, message: RemoteChatServerMessage): void {
  act(() => socket.onmessage?.({ data: JSON.stringify(message) }))
}

/** The host's answer to the card's one request. */
function answerWithBody(socket: StubSocket, ok = true): void {
  const [request] = socket.frames('activity').slice(-1)
  deliver(
    socket,
    ok
      ? { type: 'activity_result', requestId: request.requestId as string, ok: true, activity: FULL_CALL.activity }
      : { type: 'activity_result', requestId: request.requestId as string, ok: false, message: 'Gone.' }
  )
}

beforeEach(() => {
  StubSocket.instances = []
  Element.prototype.scrollIntoView = () => {}
  vi.stubGlobal('WebSocket', StubSocket)
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('no host in this test')))
  window.localStorage.clear()
  // Focus mode is on by default and hides tool activity, which is the thing under test.
  window.localStorage.setItem('toucan.focus', 'off')
})

describe('opening a tool card on the phone', () => {
  test('a card says what it is and a few words of what it produced, having asked for nothing', () => {
    const socket = open()

    expect(screen.getByRole('button', { name: /Run the tests/ })).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByText(/PASS all 12 suites/)).toBeInTheDocument()
    expect(socket.frames('activity')).toEqual([])
    // The slim snapshot had no body to render, whatever a card might later do with one.
    expect(screen.queryByText(/\$ npm test/)).not.toBeInTheDocument()
  })

  test('opening it is one activity frame, and the body is on screen only once the host answers', () => {
    const socket = open()

    fireEvent.click(screen.getByRole('button', { name: /Run the tests/ }))
    expect(socket.frames('activity')).toEqual([
      expect.objectContaining({ type: 'activity', activityId: 'call-1', requestId: expect.any(String) })
    ])
    expect(screen.getByText('Loading…')).toBeInTheDocument()
    expect(screen.queryByText(/\$ npm test/)).not.toBeInTheDocument()

    answerWithBody(socket)
    expect(screen.getByRole('button', { name: /Run the tests/ })).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText(/\$ npm test/)).toBeInTheDocument()
    expect(screen.getByText(/PASS all 12 suites/).tagName).toBe('PRE')
    expect(screen.queryByText('Loading…')).not.toBeInTheDocument()
  })

  test('closing it forgets the body, so the next open is a fresh read rather than a stale one', () => {
    const socket = open()
    fireEvent.click(screen.getByRole('button', { name: /Run the tests/ }))
    answerWithBody(socket)

    fireEvent.click(screen.getByRole('button', { name: /Run the tests/ }))
    expect(screen.queryByText(/\$ npm test/)).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Run the tests/ }))
    expect(socket.frames('activity')).toHaveLength(2)
    expect(screen.getByText('Loading…')).toBeInTheDocument()
  })

  test('a refusal is shown on the card with a way to ask again', () => {
    const socket = open()
    fireEvent.click(screen.getByRole('button', { name: /Run the tests/ }))
    answerWithBody(socket, false)

    expect(screen.getByRole('alert')).toHaveTextContent('Gone.')
    expect(screen.getByRole('button', { name: /Run the tests/ })).toHaveAttribute('aria-expanded', 'false')

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(socket.frames('activity')).toHaveLength(2)
    expect(screen.getByText('Loading…')).toBeInTheDocument()
  })

  test('a drop while the body was on its way says so instead of loading forever', () => {
    const socket = open()
    fireEvent.click(screen.getByRole('button', { name: /Run the tests/ }))

    act(() => {
      socket.readyState = 3
      socket.onclose?.()
    })
    expect(screen.getByRole('alert')).toHaveTextContent(/Disconnected before the host sent the full output/)
    expect(screen.queryByText('Loading…')).not.toBeInTheDocument()
  })
})

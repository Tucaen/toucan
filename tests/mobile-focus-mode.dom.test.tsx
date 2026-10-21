import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import ChatScreen from '../mobile/src/ChatScreen'
import type { SavedHost } from '../mobile/src/hosts'
import type { AgentEvent } from '../src/shared/agent'
import { foldAgentEvent, initialAgentTranscriptState } from '../src/shared/agent-transcript'
import type { RemoteChatSummary } from '../src/shared/remote-access'

/**
 * Focus mode on the phone: on by default, a visible toggle, and an explicit choice that outlives
 * the screen. The filtering rule itself is `tests/mobile-chat-view.test.ts`.
 */

class StubSocket {
  static instances: StubSocket[] = []
  static readonly OPEN = 1
  readyState = StubSocket.OPEN
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  constructor(
    readonly url: string,
    readonly protocols?: string[]
  ) {
    StubSocket.instances.push(this)
  }
  send(): void {}
  close(): void {
    this.readyState = 3
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

const EVENTS: AgentEvent[] = [
  { type: 'status', status: 'ready' },
  { type: 'message', role: 'user', messageId: 'u1', text: 'fix the bug' },
  { type: 'activity', activity: { id: 't1', title: 'Read parser.ts', status: 'completed', kind: 'read' } },
  { type: 'message', role: 'assistant', messageId: 'a1', text: 'the answer' },
  { type: 'turn_complete', stopReason: 'end_turn' }
]

function open(): void {
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
  const socket = StubSocket.instances[StubSocket.instances.length - 1]
  const state = EVENTS.reduce((s, e) => foldAgentEvent(s, e, 1_700_000_000_000), initialAgentTranscriptState())
  act(() => {
    socket.onopen?.()
    socket.onmessage?.({ data: JSON.stringify({ type: 'snapshot', state }) })
  })
}

const toggle = (): HTMLElement => screen.getByRole('button', { name: 'Focus' })

beforeEach(() => {
  StubSocket.instances = []
  Element.prototype.scrollIntoView = () => {}
  vi.stubGlobal('WebSocket', StubSocket)
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('no host in this test')))
  window.localStorage.clear()
})

describe('focus mode on the phone', () => {
  test('is on by default and hides tool activity while keeping the dialogue', () => {
    open()
    expect(toggle()).toHaveAttribute('aria-pressed', 'true')
    expect(screen.queryByText('Read parser.ts')).not.toBeInTheDocument()
    expect(screen.getByText('the answer')).toBeInTheDocument()
  })

  test('the toggle turns it off and on again', () => {
    open()
    fireEvent.click(toggle())
    expect(toggle()).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByText('Read parser.ts')).toBeInTheDocument()
    fireEvent.click(toggle())
    expect(screen.queryByText('Read parser.ts')).not.toBeInTheDocument()
  })

  test('an explicit choice is respected on the next open', () => {
    open()
    fireEvent.click(toggle())
    document.body.innerHTML = ''
    open()
    expect(toggle()).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByText('Read parser.ts')).toBeInTheDocument()
  })
})

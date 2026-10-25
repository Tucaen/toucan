import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import ChatScreen from '../mobile/src/ChatScreen'
import type { SavedHost } from '../mobile/src/hosts'
import type { AgentEvent } from '../src/shared/agent'
import { foldAgentEvent, initialAgentTranscriptState, type AgentTranscriptState } from '../src/shared/agent-transcript'
import type { RemoteChatServerMessage } from '../src/shared/remote-chat'
import { REMOTE_CHAT_PAGE_ENTRIES, transcriptPage, transcriptWindow } from '../src/shared/remote-transcript-page'

/**
 * The top of a long chat on the phone (#54), rendered: the join snapshot holds only the most recent
 * window, and older entries arrive as pages the loader asks for - by tapping, or by coming into
 * view - and are put in front of what the reader is looking at without moving it.
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

  constructor(readonly url: string) {
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
const PAGE = REMOTE_CHAT_PAGE_ENTRIES

/** A user prompt per entry, so every entry is one visible bubble. */
const LONG_CHAT: AgentTranscriptState = Array.from({ length: PAGE * 3 }, (_, index): AgentEvent => ({
  type: 'message',
  role: 'user',
  messageId: `u${index}`,
  text: `prompt ${index}`
})).reduce((state, event) => foldAgentEvent(state, event, 1_700_000_000_000), initialAgentTranscriptState())

function deliver(socket: StubSocket, message: RemoteChatServerMessage): void {
  act(() => socket.onmessage?.({ data: JSON.stringify(message) }))
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
  const window = transcriptWindow(LONG_CHAT)
  act(() => socket.onopen?.())
  deliver(socket, { type: 'snapshot', state: window.state, start: window.start })
  return socket
}

/** The host's answer to the loader's latest request. */
function answerPage(socket: StubSocket): void {
  const [request] = socket.frames('history').slice(-1)
  const page = transcriptPage(LONG_CHAT, request.before as string)
  deliver(socket, { type: 'history_result', requestId: request.requestId as string, ok: true, page: page! })
}

beforeEach(() => {
  StubSocket.instances = []
  Element.prototype.scrollIntoView = () => {}
  vi.stubGlobal('WebSocket', StubSocket)
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('no host in this test')))
  window.localStorage.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('earlier messages on the phone', () => {
  test('the join shows only the most recent part, and the loader fetches the rest a page at a time', () => {
    const socket = open()
    expect(screen.queryByText('prompt 0')).toBeNull()
    expect(screen.getByText(`prompt ${PAGE * 2}`)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Load earlier messages' }))
    expect(socket.frames('history')).toHaveLength(1)
    expect(screen.getByText('Loading earlier messages…')).toBeTruthy()
    answerPage(socket)
    expect(screen.getByText(`prompt ${PAGE}`)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Load earlier messages' }))
    answerPage(socket)
    expect(screen.getByText('prompt 0')).toBeTruthy()
    // The beginning of the chat: nothing older to offer.
    expect(screen.queryByRole('button', { name: 'Load earlier messages' })).toBeNull()
    expect(socket.frames('history')).toHaveLength(2)
  })

  test('a refusal is said out loud and the loader offers to try again', () => {
    const socket = open()
    fireEvent.click(screen.getByRole('button', { name: 'Load earlier messages' }))
    const [request] = socket.frames('history')
    deliver(socket, { type: 'history_result', requestId: request.requestId as string, ok: false, message: 'Gone.' })
    expect(screen.getByRole('alert').textContent).toBe('Gone.')
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(socket.frames('history')).toHaveLength(2)
  })

  test('reaching the top loads by itself, without a tap', () => {
    const observers: { callback: IntersectionObserverCallback }[] = []
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(readonly callback: IntersectionObserverCallback) {
          observers.push(this)
        }
        observe(): void {}
        disconnect(): void {}
      }
    )
    const socket = open()
    const visible = (): void =>
      act(() =>
        observers.at(-1)!.callback([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver)
      )
    visible()
    expect(socket.frames('history')).toHaveLength(1)
    answerPage(socket)
    // A fresh observer for the next page: still at the top, so it loads again.
    visible()
    expect(socket.frames('history')).toHaveLength(2)
  })

  test('a page lands above the reader without moving what they were reading', () => {
    // jsdom lays nothing out, so each item's top is its place in the list: a page put in front of
    // the first item pushes it down by exactly the page, which is what has to be scrolled back.
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      const index = Array.from(document.querySelectorAll('[data-item-key]')).indexOf(this)
      return { top: index * 10 } as DOMRect
    })
    const scrollBy = vi.fn()
    window.scrollBy = scrollBy as typeof window.scrollBy
    const socket = open()
    fireEvent.click(screen.getByRole('button', { name: 'Load earlier messages' }))
    answerPage(socket)
    expect(scrollBy).toHaveBeenCalledWith(0, PAGE * 10)
  })
})

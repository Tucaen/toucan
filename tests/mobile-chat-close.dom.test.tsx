import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi, type Mock } from 'vitest'
import ChatScreen from '../mobile/src/ChatScreen'
import type { SavedHost } from '../mobile/src/hosts'
import type { RemoteChatSummary } from '../src/shared/remote-access'

/**
 * Closing a session from the phone: never one tap, an orchestrator's ask names the ticket
 * worktrees it would orphan, and the screen leaves only on the host's verdict.
 */

class StubSocket {
  static readonly OPEN = 1
  readyState = StubSocket.OPEN
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  constructor(
    readonly url: string,
    readonly protocols?: string[]
  ) {}
  send(): void {}
  close(): void {
    this.readyState = 3
  }
}

const HOST: SavedHost = { id: 'host-1', name: 'Work PC', origin: 'http://work-pc:1789', token: 'token' }
const CHAT: RemoteChatSummary = {
  id: 'chat-1',
  kind: 'claude',
  title: 'Chat',
  projectId: 'toucan',
  status: 'idle',
  unread: 0
}
const ORCHESTRATOR: RemoteChatSummary = { ...CHAT, id: 'orch-1', title: 'Orchestrator', orchestrator: true }
const ticket = (id: string, worktree: string): RemoteChatSummary => ({
  ...CHAT,
  id,
  orchestratorId: 'orch-1',
  worktree
})

let fetchStub: Mock

function respond(close: Response, chats: RemoteChatSummary[]): void {
  fetchStub.mockImplementation((url: string, init?: RequestInit) =>
    Promise.resolve(
      init?.method === 'POST'
        ? close
        : new Response(JSON.stringify({ updatedAt: 1, projects: [], chats }), { status: 200 })
    )
  )
}

function open(summary: RemoteChatSummary) {
  const onClosed = vi.fn()
  render(
    <ChatScreen
      host={HOST}
      chatId={summary.id}
      view="chat"
      summary={summary}
      rateLimits={{}}
      onBack={() => {}}
      onOpenQuestions={() => {}}
      onCloseQuestions={() => {}}
      onClosed={onClosed}
      onUnauthorized={() => {}}
    />
  )
  return onClosed
}

const posted = (): string[] =>
  fetchStub.mock.calls.filter(([, init]) => init?.method === 'POST').map(([url]) => url as string)

beforeEach(() => {
  Element.prototype.scrollIntoView = () => {}
  vi.stubGlobal('WebSocket', StubSocket)
  fetchStub = vi.fn()
  vi.stubGlobal('fetch', fetchStub)
  window.localStorage.clear()
})

describe('closing a session from the phone', () => {
  test('asks first, and Cancel closes nothing', async () => {
    respond(new Response('{}', { status: 200 }), [CHAT])
    const onClosed = open(CHAT)
    fireEvent.click(screen.getByRole('button', { name: 'Close session' }))
    const confirm = await screen.findByRole('alertdialog', { name: 'Close session' })
    expect(confirm).toHaveTextContent('Close this session?')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(posted()).toEqual([])
    expect(onClosed).not.toHaveBeenCalled()
  })

  test('confirming closes the chat on the host and leaves the screen', async () => {
    respond(new Response('{"ok":true}', { status: 200 }), [CHAT])
    const onClosed = open(CHAT)
    fireEvent.click(screen.getByRole('button', { name: 'Close session' }))
    const confirm = await screen.findByRole('alertdialog')
    const button = await waitFor(() => {
      const found = Array.from(confirm.querySelectorAll('button')).find((b) => b.textContent === 'Close session')
      expect(found).toBeEnabled()
      return found!
    })
    await act(async () => {
      fireEvent.click(button)
    })
    expect(posted()).toEqual(['http://work-pc:1789/api/chats/chat-1/close'])
    await waitFor(() => expect(onClosed).toHaveBeenCalledTimes(1))
  })

  test('an orchestrator names the ticket worktrees it would orphan', async () => {
    respond(new Response('{}', { status: 200 }), [
      ORCHESTRATOR,
      ticket('t-1', 'ticket/34'),
      ticket('t-2', 'ticket/34'),
      ticket('t-3', 'ticket/35'),
      { ...CHAT, id: 'other', orchestratorId: 'someone-else', worktree: 'ticket/99' }
    ])
    open(ORCHESTRATOR)
    fireEvent.click(screen.getByRole('button', { name: 'Close session' }))
    const confirm = await screen.findByRole('alertdialog')
    await waitFor(() => expect(confirm).toHaveTextContent('These 2 worktrees still hold ticket sessions'))
    expect(Array.from(confirm.querySelectorAll('li')).map((item) => item.textContent)).toEqual([
      'ticket/34',
      'ticket/35'
    ])
    expect(confirm).toHaveTextContent('Close this orchestrator?')
  })

  test('a refusal is shown in the host words and the screen stays', async () => {
    respond(new Response(JSON.stringify({ error: 'Toucan is not open on the desktop.' }), { status: 503 }), [CHAT])
    const onClosed = open(CHAT)
    fireEvent.click(screen.getByRole('button', { name: 'Close session' }))
    const confirm = await screen.findByRole('alertdialog')
    const button = await waitFor(() => {
      const found = Array.from(confirm.querySelectorAll('button')).find((b) => b.textContent === 'Close session')
      expect(found).toBeEnabled()
      return found!
    })
    await act(async () => {
      fireEvent.click(button)
    })
    expect(await screen.findByText('Toucan is not open on the desktop.')).toBeInTheDocument()
    expect(onClosed).not.toHaveBeenCalled()
  })
})

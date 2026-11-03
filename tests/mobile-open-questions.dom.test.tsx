import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi, type Mock } from 'vitest'
import ChatScreen from '../mobile/src/ChatScreen'
import type { SavedHost } from '../mobile/src/hosts'
import type { RemoteChatSummary } from '../src/shared/remote-access'

/**
 * The pinned open-questions banner on the phone: each question once, verbatim, above the
 * transcript; Erledigt resolves it on the host, Antworten starts the composer with `Zu Q<n>: `.
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
const ORCHESTRATOR: RemoteChatSummary = {
  id: 'orch-1',
  kind: 'claude',
  title: 'Orchestrator',
  projectId: 'toucan',
  status: 'idle',
  unread: 0,
  orchestrator: true
}
const QUESTIONS = [
  { id: 'Q1', ticketId: '3', markdown: 'Which **branch** should ship?', createdAt: 1 },
  { id: 'Q2', ticketId: '4', markdown: 'See [shot](file:///D:/x/shot.png) first', createdAt: 2 }
]
const WITH_QUESTIONS: RemoteChatSummary = { ...ORCHESTRATOR, openQuestions: QUESTIONS }

function open(summary: RemoteChatSummary): void {
  render(
    <ChatScreen
      host={HOST}
      chatId={summary.id}
      summary={summary}
      rateLimits={{}}
      onBack={() => {}}
      onUnauthorized={() => {}}
    />
  )
}

const posted = (fetchStub: Mock): string[] =>
  fetchStub.mock.calls.filter(([, init]) => init?.method === 'POST').map(([url]) => url as string)

let fetchStub: Mock

beforeEach(() => {
  Element.prototype.scrollIntoView = () => {}
  vi.stubGlobal('WebSocket', StubSocket)
  fetchStub = vi.fn().mockImplementation(() => Promise.resolve(new Response('{}', { status: 200 })))
  vi.stubGlobal('fetch', fetchStub)
  window.localStorage.clear()
})

describe('open questions on the phone', () => {
  test('pins every question with its count and markdown', () => {
    open(WITH_QUESTIONS)
    expect(screen.getByRole('heading', { name: 'Offene Fragen (2)' })).toBeInTheDocument()
    expect(screen.getByText('branch')).toBeInTheDocument()
    expect(screen.getByText('Q1')).toBeInTheDocument()
    expect(screen.getByText('Q2')).toBeInTheDocument()
  })

  test('is absent without open questions', () => {
    open(ORCHESTRATOR)
    expect(screen.queryByText(/Offene Fragen/)).not.toBeInTheDocument()
  })

  test('Erledigt asks the host to resolve that question', async () => {
    open(WITH_QUESTIONS)
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: 'Erledigt' })[1])
    })
    await waitFor(() =>
      expect(posted(fetchStub)).toEqual(['http://work-pc:1789/api/chats/orch-1/questions/Q2/resolve'])
    )
  })

  test('a refusal is shown in the host words', async () => {
    fetchStub.mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify({ error: 'That question is gone.' }), { status: 409 }))
    )
    open(WITH_QUESTIONS)
    fireEvent.click(screen.getAllByRole('button', { name: 'Erledigt' })[0])
    expect(await screen.findByText('That question is gone.')).toBeInTheDocument()
  })

  test('Antworten prefills the composer with Zu Q<n>: ', () => {
    open(WITH_QUESTIONS)
    fireEvent.click(screen.getAllByRole('button', { name: 'Antworten' })[0])
    expect(screen.getByLabelText('Message')).toHaveValue('Zu Q1: ')
  })

  test('the banner goes when a later workspace read lists no questions', async () => {
    vi.useFakeTimers()
    try {
      fetchStub.mockImplementation(() =>
        Promise.resolve(
          new Response(JSON.stringify({ updatedAt: 1, projects: [], chats: [ORCHESTRATOR] }), { status: 200 })
        )
      )
      open(WITH_QUESTIONS)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3_100)
      })
      expect(screen.queryByText(/Offene Fragen/)).not.toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })
})

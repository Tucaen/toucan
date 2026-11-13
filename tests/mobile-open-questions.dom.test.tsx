import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { beforeEach, describe, expect, test, vi, type Mock } from 'vitest'
import ChatScreen from '../mobile/src/ChatScreen'
import type { SavedHost } from '../mobile/src/hosts'
import type { RemoteChatSummary } from '../src/shared/remote-access'

/**
 * An orchestrator's open questions on the phone: a link in the chat's sticky header opens a view
 * of their own, one tab per question, in place of the transcript. Erledigt resolves one on the
 * host, Antworten returns to the chat with the composer started as `Zu Q<n>: `, and closing the
 * view returns to the orchestrator it was opened from.
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
  { id: 'Q2', ticketId: '4', markdown: 'See the screenshot first', createdAt: 2 }
]
const CHOICE = {
  id: 'Q3',
  ticketId: '5',
  markdown: 'Which branch?',
  options: [{ label: 'Left', description: 'the old one' }, { label: 'Right' }],
  createdAt: 3
}
const WITH_CHOICE: RemoteChatSummary = { ...ORCHESTRATOR, openQuestions: [CHOICE, QUESTIONS[0]] }
const WITH_QUESTIONS: RemoteChatSummary = { ...ORCHESTRATOR, openQuestions: QUESTIONS }

/** The chat screen with the view switching App does, so a test can walk between the two. */
function Harness({
  summary,
  initialView,
  onOpenQuestions,
  onCloseQuestions
}: {
  summary: RemoteChatSummary
  initialView: 'chat' | 'questions'
  onOpenQuestions(chatId: string): void
  onCloseQuestions(chatId: string): void
}): JSX.Element {
  const [view, setView] = useState(initialView)
  return (
    <ChatScreen
      host={HOST}
      chatId={summary.id}
      view={view}
      summary={summary}
      rateLimits={{}}
      onBack={() => {}}
      onOpenQuestions={(chatId) => {
        onOpenQuestions(chatId)
        setView('questions')
      }}
      onCloseQuestions={(chatId) => {
        onCloseQuestions(chatId)
        setView('chat')
      }}
      onClosed={() => {}}
      onUnauthorized={() => {}}
    />
  )
}

function open(summary: RemoteChatSummary, initialView: 'chat' | 'questions' = 'chat') {
  const onOpenQuestions = vi.fn()
  const onCloseQuestions = vi.fn()
  render(
    <Harness
      summary={summary}
      initialView={initialView}
      onOpenQuestions={onOpenQuestions}
      onCloseQuestions={onCloseQuestions}
    />
  )
  return { onOpenQuestions, onCloseQuestions }
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

describe('the open-questions link in the chat', () => {
  test('counts the questions in the header and keeps them out of the transcript', () => {
    open(WITH_QUESTIONS)
    expect(screen.getByRole('button', { name: '2 offene Fragen ›' })).toBeInTheDocument()
    expect(screen.queryByText('branch')).not.toBeInTheDocument()
  })

  test('is absent without open questions', () => {
    open(ORCHESTRATOR)
    expect(screen.queryByText(/offene Frage/)).not.toBeInTheDocument()
  })

  test('opens the questions view of this orchestrator', () => {
    const { onOpenQuestions } = open(WITH_QUESTIONS)
    fireEvent.click(screen.getByRole('button', { name: '2 offene Fragen ›' }))
    expect(onOpenQuestions).toHaveBeenCalledWith('orch-1')
    expect(screen.getByRole('heading', { name: 'Offene Fragen' })).toBeInTheDocument()
    expect(screen.queryByLabelText('Message')).not.toBeInTheDocument()
  })

  test('goes when a later workspace read lists no questions', async () => {
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
      expect(screen.queryByText(/offene Frage/)).not.toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('the questions view', () => {
  test('has one tab per question and shows the oldest first', () => {
    open(WITH_QUESTIONS, 'questions')
    const tabs = screen.getAllByRole('tab')
    expect(tabs.map((tab) => tab.textContent)).toEqual(['Q1 · #3', 'Q2 · #4'])
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Which branch should ship?')
  })

  test('a tab shows its own question', () => {
    open(WITH_QUESTIONS, 'questions')
    fireEvent.click(screen.getByRole('tab', { name: 'Q2 · #4' }))
    expect(screen.getByRole('tabpanel')).toHaveTextContent('See the screenshot first')
  })

  test('closing returns to the orchestrator it was opened from', () => {
    const { onCloseQuestions } = open(WITH_QUESTIONS, 'questions')
    fireEvent.click(screen.getByRole('button', { name: 'Back to the orchestrator' }))
    expect(onCloseQuestions).toHaveBeenCalledWith('orch-1')
    expect(screen.getByLabelText('Message')).toBeInTheDocument()
  })

  test('Erledigt resolves the shown question and its tab goes at once', async () => {
    open(WITH_QUESTIONS, 'questions')
    fireEvent.click(screen.getByRole('tab', { name: 'Q2 · #4' }))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Erledigt' }))
    })
    await waitFor(() =>
      expect(posted(fetchStub)).toEqual(['http://work-pc:1789/api/chats/orch-1/questions/Q2/resolve'])
    )
    expect(fetchStub.mock.calls.find(([, call]) => call?.method === 'POST')![1].body).toBeUndefined()
    await waitFor(() => expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Q1 · #3']))
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Which branch should ship?')
  })

  test('a refusal is shown in the host words and the tab stays', async () => {
    fetchStub.mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify({ error: 'That question is gone.' }), { status: 409 }))
    )
    open(WITH_QUESTIONS, 'questions')
    fireEvent.click(screen.getByRole('button', { name: 'Erledigt' }))
    expect(await screen.findByText('That question is gone.')).toBeInTheDocument()
    expect(screen.getAllByRole('tab')).toHaveLength(2)
  })

  test('Antworten returns to the chat with the composer started as Zu Q<n>: ', () => {
    const { onCloseQuestions } = open(WITH_QUESTIONS, 'questions')
    fireEvent.click(screen.getByRole('button', { name: 'Antworten' }))
    expect(onCloseQuestions).toHaveBeenCalledWith('orch-1')
    expect(screen.getByLabelText('Message')).toHaveValue('Zu Q1: ')
  })

  test('says so when every question is resolved', () => {
    open(ORCHESTRATOR, 'questions')
    expect(screen.getByText('Keine offenen Fragen.')).toBeInTheDocument()
  })

  test('a question with options shows a decision card and resolves with the pick as its note', async () => {
    open(WITH_CHOICE, 'questions')
    expect(screen.getByText('the old one')).toBeInTheDocument()
    expect(screen.getByLabelText('Other answer')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Right/ }))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Submit answers' }))
    })
    await waitFor(() =>
      expect(posted(fetchStub)).toEqual(['http://work-pc:1789/api/chats/orch-1/questions/Q3/resolve'])
    )
    const [, init] = fetchStub.mock.calls.find(([, call]) => call?.method === 'POST')!
    expect(JSON.parse(init.body as string)).toEqual({ note: 'Answer: Right' })
    expect(init.headers['content-type']).toBe('application/json')
  })

  test('the answer panel collapses to a bar and expands again with its options intact', () => {
    open(WITH_CHOICE, 'questions')
    const toggle = screen.getByRole('button', { name: /Antworten ausblenden/ })
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    fireEvent.click(screen.getByRole('button', { name: /Right/ }))
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByLabelText('Other answer')).not.toBeVisible()
    expect(screen.getByText('Antworten anzeigen')).toBeInTheDocument()
    fireEvent.click(toggle)
    expect(screen.getByLabelText('Other answer')).toBeVisible()
    expect(screen.getByRole('button', { name: /Right/ })).toHaveAttribute('aria-pressed', 'true')
  })

  test('a plain question shows no decision card', () => {
    open(WITH_QUESTIONS, 'questions')
    expect(document.querySelectorAll('.pending-request[data-kind="decision"]')).toHaveLength(0)
  })
})

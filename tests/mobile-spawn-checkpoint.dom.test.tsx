import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import ChatScreen from '../mobile/src/ChatScreen'
import type { SavedHost } from '../mobile/src/hosts'
import type { RemoteChatSummary } from '../src/shared/remote-access'

/**
 * Continue (+20) on the phone: shown for an orchestrator at its spawn budget, with the desktop's
 * wording, and pressing it asks the host to run the desktop's own continue operation.
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
const AT_BUDGET: RemoteChatSummary = { ...ORCHESTRATOR, spawnCheckpoint: { used: 20, budget: 20 } }

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

const posted = (fetchStub: ReturnType<typeof vi.fn>): string[] =>
  fetchStub.mock.calls.filter(([, init]) => init?.method === 'POST').map(([url]) => url as string)

let fetchStub: ReturnType<typeof vi.fn>

beforeEach(() => {
  Element.prototype.scrollIntoView = () => {}
  vi.stubGlobal('WebSocket', StubSocket)
  fetchStub = vi.fn().mockImplementation(() => Promise.resolve(new Response('{}', { status: 200 })))
  vi.stubGlobal('fetch', fetchStub)
  window.localStorage.clear()
})

describe('Continue (+20) on the phone', () => {
  test('is shown with the desktop wording for an orchestrator at its budget', () => {
    open(AT_BUDGET)
    expect(screen.getByText('Spawn budget reached (20/20) — waiting for you')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Continue (+20)' })).toBeEnabled()
  })

  test('is absent when the orchestration is not at its budget', () => {
    open(ORCHESTRATOR)
    expect(screen.queryByRole('button', { name: 'Continue (+20)' })).not.toBeInTheDocument()
  })

  test('pressing it asks the host to continue that orchestrator', async () => {
    open(AT_BUDGET)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Continue (+20)' }))
    })
    await waitFor(() => expect(posted(fetchStub)).toEqual(['http://work-pc:1789/api/chats/orch-1/continue-spawns']))
  })

  test("a refusal is shown in the host's words", async () => {
    fetchStub.mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify({ error: 'That chat is not an orchestrator.' }), { status: 409 }))
    )
    open(AT_BUDGET)
    fireEvent.click(screen.getByRole('button', { name: 'Continue (+20)' }))
    expect(await screen.findByText('That chat is not an orchestrator.')).toBeInTheDocument()
  })

  test('the card goes when a later workspace read no longer reports the checkpoint', async () => {
    vi.useFakeTimers()
    try {
      fetchStub.mockImplementation(() =>
        Promise.resolve(
          new Response(JSON.stringify({ updatedAt: 1, projects: [], chats: [ORCHESTRATOR] }), { status: 200 })
        )
      )
      open(AT_BUDGET)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3_100)
      })
      expect(screen.queryByRole('button', { name: 'Continue (+20)' })).not.toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })
})

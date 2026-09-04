import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import NewChatScreen from '../mobile/src/NewChatScreen'
import type { RemoteWorkspaceSnapshot } from '../src/shared/remote-access'

/**
 * Starting a chat, rendered. The form's rules are pure and covered in `tests/mobile-new-chat.test.ts`;
 * what only a DOM test can state is the wait and what it costs.
 *
 * `POST /api/chats` is held open by the host until a session actually exists, so the reader spends
 * real seconds on this screen: the form has to stay busy rather than resubmittable, a failure has
 * to leave what was typed intact so it can be retried, and the screen must navigate only on an id
 * the host vouched for - never optimistically, because there would be no chat behind it.
 */

const SNAPSHOT: RemoteWorkspaceSnapshot = {
  updatedAt: 1_000,
  projects: [
    { id: 'toucan', name: 'Toucan', color: '#71a9ff' },
    { id: 'other', name: 'Other', color: '#ff9f71' }
  ],
  chats: []
}

/** Resolves `POST /api/chats` on demand, so "still starting" is a state the test can assert in. */
function deferredPost(): {
  fetch: ReturnType<typeof vi.fn>
  body(): Record<string, unknown>
  reply(status: number, payload: unknown): void
} {
  let settle: ((response: Response) => void) | null = null
  let sent = '{}'
  const fetch = vi.fn((path: string, init?: RequestInit) => {
    if (path === '/api/workspace') {
      return Promise.resolve(new Response(JSON.stringify(SNAPSHOT), { status: 200 }))
    }
    sent = typeof init?.body === 'string' ? init.body : '{}'
    return new Promise<Response>((resolve) => {
      settle = resolve
    })
  })
  return {
    fetch,
    body: () => JSON.parse(sent) as Record<string, unknown>,
    reply: (status, payload) => settle?.(new Response(JSON.stringify(payload), { status }))
  }
}

let spawned: string[]
let unauthorized: number

function renderScreen(fetchStub: ReturnType<typeof vi.fn>): void {
  vi.stubGlobal('fetch', fetchStub)
  render(
    <NewChatScreen
      token="pairing-token"
      onBack={() => undefined}
      onUnauthorized={() => {
        unauthorized += 1
      }}
      onSpawned={(chatId) => spawned.push(chatId)}
    />
  )
}

beforeEach(() => {
  spawned = []
  unauthorized = 0
})

describe('starting a chat from the phone', () => {
  test('sends the picked project, agent and first message, and lands in the chat the host vouched for', async () => {
    const post = deferredPost()
    renderScreen(post.fetch)

    // The project list is the desktop's, read once when the form opens.
    await screen.findByRole('radio', { name: /Other/ })
    fireEvent.click(screen.getByRole('radio', { name: /Other/ }))
    fireEvent.click(screen.getByRole('radio', { name: 'Codex' }))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '  fix the parser  ' } })

    fireEvent.click(screen.getByRole('button', { name: 'Start chat' }))
    // Trimmed by the shared request builder, so the host receives what the desktop would have sent.
    await waitFor(() => expect(post.body()).toEqual({ projectId: 'other', kind: 'codex', input: 'fix the parser' }))

    // Held open by the host while the session comes up: the form says so and cannot be sent twice.
    expect(await screen.findByText('Waiting for the desktop to start the session…')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Starting…' })).toBeDisabled()
    expect(spawned).toEqual([])

    post.reply(201, { chatId: 'node-9' })
    await waitFor(() => expect(spawned).toEqual(['node-9']))
  })

  test('an empty first message is omitted rather than sent as a blank prompt', async () => {
    const post = deferredPost()
    renderScreen(post.fetch)
    await screen.findByRole('radio', { name: /Toucan/ })

    fireEvent.click(screen.getByRole('button', { name: 'Start chat' }))
    await waitFor(() => expect(post.body()).toEqual({ projectId: 'toucan', kind: 'claude' }))
  })

  test('a desktop that could not start it says why, and keeps what was typed', async () => {
    const post = deferredPost()
    renderScreen(post.fetch)
    await screen.findByRole('radio', { name: /Toucan/ })
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'fix the parser' } })
    fireEvent.click(screen.getByRole('button', { name: 'Start chat' }))
    await waitFor(() => expect(post.fetch).toHaveBeenCalledTimes(2))

    post.reply(503, { error: 'Toucan is not open on the desktop, so there is nothing to start the chat in.' })

    // The host's own wording, not a generic status - and no navigation, because there is no chat.
    expect(await screen.findByRole('alert')).toHaveTextContent('Toucan is not open on the desktop')
    expect(spawned).toEqual([])
    // Retryable without retyping: the reader may simply need to open the desktop.
    expect(screen.getByRole('textbox')).toHaveValue('fix the parser')
    expect(screen.getByRole('button', { name: 'Start chat' })).toBeEnabled()
  })

  test('a revoked token unpairs instead of showing a failed spawn', async () => {
    const post = deferredPost()
    renderScreen(post.fetch)
    await screen.findByRole('radio', { name: /Toucan/ })
    fireEvent.click(screen.getByRole('button', { name: 'Start chat' }))
    await waitFor(() => expect(post.fetch).toHaveBeenCalledTimes(2))

    post.reply(401, { error: 'unauthorized' })
    await waitFor(() => expect(unauthorized).toBe(1))
    expect(spawned).toEqual([])
  })
})

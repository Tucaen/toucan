import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { SavedHost } from '../mobile/src/hosts'
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

const HOST: SavedHost = { id: 'host-1', name: 'Work PC', origin: 'http://work-pc:1789', token: 'pairing-token' }

const SNAPSHOT: RemoteWorkspaceSnapshot = {
  updatedAt: 1_000,
  projects: [
    { id: 'toucan', name: 'Toucan', color: '#71a9ff' },
    { id: 'other', name: 'Other', color: '#ff9f71' }
  ],
  chats: []
}

/** Resolves `POST /api/chats` on demand, so "still starting" is a state the test can assert in. */
function deferredPost(catalogue: unknown = {}): {
  fetch: ReturnType<typeof vi.fn>
  body(): Record<string, unknown>
  /** How many spawns were attempted; the form also reads the workspace and the model catalogue. */
  posts(): number
  reply(status: number, payload: unknown): void
} {
  let settle: ((response: Response) => void) | null = null
  let sent = '{}'
  let posts = 0
  const fetch = vi.fn((path: string, init?: RequestInit) => {
    if (path === `${HOST.origin}/api/workspace`) {
      return Promise.resolve(new Response(JSON.stringify(SNAPSHOT), { status: 200 }))
    }
    if (path === `${HOST.origin}/api/models`) {
      return Promise.resolve(new Response(JSON.stringify(catalogue), { status: 200 }))
    }
    posts += 1
    sent = typeof init?.body === 'string' ? init.body : '{}'
    return new Promise<Response>((resolve) => {
      settle = resolve
    })
  })
  return {
    fetch,
    body: () => JSON.parse(sent) as Record<string, unknown>,
    posts: () => posts,
    reply: (status, payload) => settle?.(new Response(JSON.stringify(payload), { status }))
  }
}

let spawned: string[]
let unauthorized: number

function renderScreen(fetchStub: ReturnType<typeof vi.fn>): void {
  vi.stubGlobal('fetch', fetchStub)
  render(
    <NewChatScreen
      host={HOST}
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
    await waitFor(() => expect(post.posts()).toBe(1))

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
    await waitFor(() => expect(post.posts()).toBe(1))

    post.reply(401, { error: 'unauthorized' })
    await waitFor(() => expect(unauthorized).toBe(1))
    expect(spawned).toEqual([])
  })
})

/**
 * The model picker on the new-chat form. Its rules are pure (`tests/mobile-new-chat.test.ts`); what
 * only a DOM test states is that the catalogue is read without blocking the form, that a host which
 * knows nothing still starts chats, and that the picked model is what leaves in the body.
 */
describe('choosing the model a new chat starts on', () => {
  const CATALOGUE = {
    claude: [
      { id: 'sonnet', name: 'Sonnet' },
      { id: 'opus', name: 'Opus' }
    ],
    codex: [{ id: 'gpt-5-codex', name: 'GPT-5 Codex' }]
  }

  test('offers what the desktop last saw the selected agent advertise, and sends the pick', async () => {
    const post = deferredPost(CATALOGUE)
    renderScreen(post.fetch)
    await screen.findByRole('radio', { name: /Toucan/ })

    const picker = await screen.findByLabelText('Model')
    await waitFor(() =>
      expect([...(picker as HTMLSelectElement).options].map((option) => option.textContent)).toEqual([
        'Desktop default',
        'Sonnet',
        'Opus'
      ])
    )

    fireEvent.change(picker, { target: { value: 'opus' } })
    fireEvent.click(screen.getByRole('button', { name: 'Start chat' }))
    await waitFor(() => expect(post.body()).toEqual({ projectId: 'toucan', kind: 'claude', modelId: 'opus' }))
  })

  test('switching agent re-offers that agent\u2019s models and drops the model picked for the other', async () => {
    const post = deferredPost(CATALOGUE)
    renderScreen(post.fetch)
    await screen.findByRole('radio', { name: /Toucan/ })
    const picker = await screen.findByLabelText('Model')
    await waitFor(() => expect((picker as HTMLSelectElement).options.length).toBe(3))

    fireEvent.change(picker, { target: { value: 'opus' } })
    fireEvent.click(screen.getByRole('radio', { name: 'Codex' }))

    // Back to the default, because the two providers share no ids and the host would refuse it.
    expect((screen.getByLabelText('Model') as HTMLSelectElement).value).toBe('')
    expect([...(screen.getByLabelText('Model') as HTMLSelectElement).options].map((o) => o.textContent)).toEqual([
      'Desktop default',
      'GPT-5 Codex'
    ])

    fireEvent.click(screen.getByRole('button', { name: 'Start chat' }))
    await waitFor(() => expect(post.body()).toEqual({ projectId: 'toucan', kind: 'codex' }))
  })

  test('a desktop that has never run the agent says so, and the chat still starts', async () => {
    const post = deferredPost({})
    renderScreen(post.fetch)
    await screen.findByRole('radio', { name: /Toucan/ })

    expect(await screen.findByText(/has not run Claude yet/)).toBeTruthy()
    // Not a blocker: the form is submittable and the body simply names no model.
    expect(screen.getByRole('button', { name: 'Start chat' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: 'Start chat' }))
    await waitFor(() => expect(post.body()).toEqual({ projectId: 'toucan', kind: 'claude' }))
  })
})

import { fireEvent, screen, waitFor } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import type { RemoteAccessState, RemoteWorkspaceProjection } from '../src/shared/remote-access'
import type { RemoteChatSpawnRequest, RemoteChatSpawnResult } from '../src/shared/remote-spawn'
import type { AgentApi } from '../src/shared/agent'
import type { WorkspaceState } from '../src/shared/terminal'
import { attentionItemId, type AttentionItem } from '../src/shared/attention'
import { createMockAgentApi } from './dom/agent-api-mock'
import {
  DEFAULT_PROJECT as project,
  renderApp as renderAppHarness,
  savedWorkspace as harnessWorkspace
} from './dom/app-harness'

/**
 * Remote access as the user meets it: a header control that says whether the host is listening, a
 * dialog that turns it on and shows the pairing token, and the canvas projection the phone lists.
 *
 * The projection assertions are the load-bearing ones: the canvas stays the single authority on
 * what a phone lists, so the test reads what actually crossed the preload seam rather than
 * re-deriving it. Which node kinds qualify is decided by `deriveRemoteWorkspaceProjection` and
 * covered in `tests/remote-access.test.ts`.
 */

const savedWorkspace = (overrides: Partial<WorkspaceState> = {}): WorkspaceState =>
  harnessWorkspace({
    nodes: [
      {
        id: 'chat-1',
        kind: 'claude',
        label: 'Fix the parser',
        projectId: project.id,
        position: { x: 0, y: 0 },
        width: 520,
        height: 340
      }
    ],
    ...overrides
  })

function remoteState(overrides: Partial<RemoteAccessState> = {}): RemoteAccessState {
  return {
    settings: { enabled: false, port: 7391 },
    listening: false,
    token: 'pairing-token-value',
    tokenUpdatedAt: 1_000,
    addresses: [{ kind: 'tailscale', host: '100.1.2.3' }],
    ...overrides
  }
}

let published: RemoteWorkspaceProjection[]
let applied: { enabled: boolean; port: number }[]
let copied: string[]
let regenerated: number
/** The host's side of a spawn: what it asked, and what the renderer eventually answered. */
let requestSpawn: ((requestId: string, request: RemoteChatSpawnRequest) => void) | null
let spawnResults: { requestId: string; result: RemoteChatSpawnResult; publishedByThen: number }[]
/** The host's side of a phone reporting that it read a chat. One way: there is nothing to answer. */
let reportRead: ((chatId: string) => void) | null

/** The bridges this suite is actually about, over the harness defaults. */
function remoteApis(
  initial: RemoteAccessState,
  agentOverrides: Partial<AgentApi>
): Record<string, Record<string, unknown>> {
  published = []
  applied = []
  copied = []
  regenerated = 0
  requestSpawn = null
  spawnResults = []
  reportRead = null

  return {
    terminalApi: { copyText: vi.fn((text: string) => copied.push(text)) },
    agentApi: createMockAgentApi(agentOverrides).api as unknown as Record<string, unknown>,
    remoteApi: {
      state: vi.fn(async () => initial),
      applySettings: vi.fn(async (settings: { enabled: boolean; port: number }) => {
        applied.push(settings)
        return remoteState({ settings, listening: settings.enabled, boundPort: settings.port })
      }),
      regenerateToken: vi.fn(async () => {
        regenerated += 1
        return remoteState({ token: 'a-new-token' })
      }),
      publishWorkspace: vi.fn((projection: RemoteWorkspaceProjection) => published.push(projection)),
      onStateChange: () => () => undefined,
      onSpawnChat: (callback: (requestId: string, request: RemoteChatSpawnRequest) => void) => {
        requestSpawn = callback
        return () => {
          requestSpawn = null
        }
      },
      // `publishedByThen` is recorded so a test can ask what the host had been handed at the
      // moment it was answered - the ordering the phone's very next request depends on.
      completeSpawn: (requestId: string, result: RemoteChatSpawnResult) =>
        spawnResults.push({ requestId, result, publishedByThen: published.length }),
      onMarkChatRead: (callback: (chatId: string) => void) => {
        reportRead = callback
        return () => {
          reportRead = null
        }
      }
    }
  }
}

async function renderApp(
  initial: RemoteAccessState = remoteState(),
  agentOverrides: Partial<AgentApi> = {},
  state: WorkspaceState = savedWorkspace()
): Promise<void> {
  await renderAppHarness({ state, apis: remoteApis(initial, agentOverrides) })
}

describe('the workspace projection a phone lists', () => {
  test('carries agent chats and never a plain terminal', async () => {
    await renderApp()
    await waitFor(() => expect(published.length).toBeGreaterThan(0))

    const latest = published[published.length - 1]
    expect(latest.projects).toEqual([{ id: project.id, name: project.name, color: project.color }])
    expect(latest.chats.map((chat) => chat.id)).toEqual(['chat-1'])
    expect(latest.chats[0].title).toBe('Fix the parser')
    expect(latest.chats[0].kind).toBe('claude')
  })

  test('the same projection is never published twice in a row', async () => {
    await renderApp()
    await waitFor(() => expect(published.length).toBeGreaterThan(0))

    // Sidebar collapse rewrites the workspace snapshot without changing anything a phone shows,
    // which is the cheap stand-in for the expensive case: a node drag rebuilding it per frame.
    fireEvent.click(screen.getByTitle('Collapse projects'))
    await waitFor(() => expect(screen.getByTitle('Expand projects')).toBeTruthy())

    const serialized = published.map((projection) => JSON.stringify(projection))
    const repeated = serialized.filter((entry, index) => index > 0 && entry === serialized[index - 1])
    expect(repeated).toEqual([])
  })
})

describe('the remote access dialog', () => {
  test('the header control reports that the host is not listening', async () => {
    await renderApp()
    const control = await screen.findByTitle(/Remote access is off/)
    expect(control).not.toHaveAttribute('data-listening')
  })

  test('turning it on sends the settings the user chose', async () => {
    await renderApp()
    fireEvent.click(screen.getByTitle(/Remote access is off/))

    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('Not listening')
    // Nothing to apply until something changes.
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled()

    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.change(screen.getByDisplayValue('7391'), { target: { value: '7500' } })
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))

    await waitFor(() => expect(applied).toEqual([{ enabled: true, port: 7500 }]))
    await screen.findByText(/Listening on port 7500/)
    // The tailnet address is what the user types on the phone, so the dialog has to show it.
    await screen.findByText(/100.1.2.3:7500/)
  })

  test('a port the host could not bind is refused before it is applied', async () => {
    await renderApp()
    fireEvent.click(screen.getByTitle(/Remote access is off/))
    await screen.findByRole('dialog')

    fireEvent.change(screen.getByDisplayValue('7391'), { target: { value: '80' } })
    expect(await screen.findByText(/1024 or higher/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled()
    expect(applied).toEqual([])
  })

  test('the token can be copied and regenerated', async () => {
    await renderApp(remoteState({ settings: { enabled: true, port: 7391 }, listening: true, boundPort: 7391 }))
    fireEvent.click(await screen.findByTitle(/Remote access is on/))
    await screen.findByRole('dialog')

    expect(screen.getByText('pairing-token-value')).toBeTruthy()
    fireEvent.click(screen.getByTitle('Copy the pairing token'))
    expect(copied).toEqual(['pairing-token-value'])

    fireEvent.click(screen.getByTitle(/Generate a new token/))
    await waitFor(() => expect(regenerated).toBe(1))
    await screen.findByText('a-new-token')
  })
})

/**
 * Spawning, read from the renderer's side of the seam. Node identity is the canvas's, so what has
 * to hold here is that the host's request goes through the *same* add-node path a right-click uses,
 * and that the answer it gets back describes a session that actually came up - the phone navigates
 * on that answer, so an optimistic one would be a chat that is not there.
 */
describe('a chat a phone asked for', () => {
  const request: RemoteChatSpawnRequest = { projectId: project.id, kind: 'codex', input: 'fix the parser' }

  test('is added to the canvas and answered with its id once the session is up', async () => {
    await renderApp()
    await waitFor(() => expect(requestSpawn).not.toBeNull())

    requestSpawn!('req-1', request)

    await waitFor(() => expect(spawnResults).toHaveLength(1))
    const answer = spawnResults[0]
    expect(answer.requestId).toBe('req-1')
    expect(answer.result.ok).toBe(true)

    const chatId = (answer.result as { chatId: string }).chatId
    // The id was only reported once the host already held a projection listing it. Joining a chat
    // socket is gated on that list, so an answer that arrived first would hand the phone an id its
    // very next request would be refused for.
    const knownWhenAnswered = published
      .slice(0, answer.publishedByThen)
      .some((projection) => projection.chats.some((chat) => chat.id === chatId))
    expect(knownWhenAnswered).toBe(true)

    // And it is an ordinary canvas node: it stays in the projection like every other one.
    const spawned = published[published.length - 1].chats.find((chat) => chat.id === chatId)!
    expect(spawned.kind).toBe('codex')
    expect(spawned.projectId).toBe(project.id)
  })

  test('a project the canvas no longer has is refused without adding anything', async () => {
    await renderApp()
    await waitFor(() => expect(requestSpawn).not.toBeNull())
    const before = published[published.length - 1].chats.length

    requestSpawn!('req-1', { projectId: 'closed-project', kind: 'claude' })

    await waitFor(() => expect(spawnResults).toHaveLength(1))
    expect(spawnResults[0].result).toEqual({
      ok: false,
      message: 'That project is no longer open on the desktop.'
    })
    expect(published[published.length - 1].chats.length).toBe(before)
  })

  test('a session that cannot start is reported as a failure, not as a chat', async () => {
    // The node is added either way - that is the canvas's own path - but the spawn only succeeds
    // if a session came up behind it, which is the difference between a chat and a phantom.
    await renderApp(remoteState(), { create: vi.fn(async () => ({ ok: false as const, error: 'no adapter' })) })
    await waitFor(() => expect(requestSpawn).not.toBeNull())

    requestSpawn!('req-1', request)

    await waitFor(() => expect(spawnResults).toHaveLength(1))
    expect(spawnResults[0].result.ok).toBe(false)
    expect((spawnResults[0].result as { message: string }).message).toMatch(/could not be started/)
  })
})

/**
 * Reading a chat on the phone. The canvas stays the authority on attention, so the phone does not
 * clear a badge - it reports a read, and the canvas applies its own, with the same kinds a look at
 * the node would clear. The projection the phone polls is where the result shows up, which is why
 * the assertion is on what crossed the seam rather than on anything drawn here.
 */
describe('a chat read on the phone', () => {
  const unreadRecord = (kind: 'result' | 'approval', key: string): AttentionItem => ({
    id: attentionItemId('chat-1', kind, key),
    nodeId: 'chat-1',
    kind,
    key,
    createdAt: 1_000,
    updatedAt: 1_000,
    events: 1,
    read: false
  })

  async function renderWithUnread(): Promise<void> {
    await renderApp(remoteState(), {}, savedWorkspace({ attention: [unreadRecord('result', 'r1')] }))
    await waitFor(() => expect(published.length).toBeGreaterThan(0))
    expect(published[published.length - 1].chats[0].unread).toBe(1)
  }

  test('retires the unread the phone was looking at, in the next published projection', async () => {
    await renderWithUnread()
    await waitFor(() => expect(reportRead).not.toBeNull())

    reportRead!('chat-1')

    await waitFor(() => expect(published[published.length - 1].chats[0].unread).toBe(0))
  })

  test('does not retire a pending approval, because looking at one is not answering it', async () => {
    await renderApp(
      remoteState(),
      {},
      savedWorkspace({ attention: [unreadRecord('result', 'r1'), unreadRecord('approval', 'req-7')] })
    )
    await waitFor(() => expect(reportRead).not.toBeNull())

    reportRead!('chat-1')

    await waitFor(() => expect(published[published.length - 1].chats[0].unread).toBe(1))
    expect(published[published.length - 1].chats[0].attention).toBe('approval')
  })

  test('a read for a chat the canvas no longer has clears nothing and breaks nothing', async () => {
    await renderWithUnread()
    await waitFor(() => expect(reportRead).not.toBeNull())

    reportRead!('a-node-that-was-closed')

    // Still exactly what it was: an unknown id matches no record, so nothing is retired.
    await waitFor(() => expect(published[published.length - 1].chats[0].unread).toBe(1))
  })
})

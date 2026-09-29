import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import type { AgentCreateRequest } from '../src/shared/agent'
import type { ConversationSummary } from '../src/shared/conversation-history'
import type { WorkspaceState, WorkspaceTerminalNode } from '../src/shared/workspace'
import type { WorkspaceWorktree, WorktreeDiscoverResult, WorktreeRemoveResult } from '../src/shared/worktree'
import { createMockAgentApi } from './dom/agent-api-mock'
import { DEFAULT_PROJECT, renderApp, savedWorkspace, type AppHarness } from './dom/app-harness'

/**
 * Issue #26 end to end, through the real `App`: every way a conversation is opened or adopted -
 * Add chat, a handoff, a late claim, a branch, History, Ctrl+Shift+T - lands it on the canvas of
 * the worktree it runs in, exactly once and with one owner; closing a chat is the ordinary
 * per-node close and never touches the checkout; and removal keeps its evidence-based gate.
 */

const WORKTREE_PATH = 'D:\\Development\\Toucan-worktrees\\feature-login'

const worktree: WorkspaceWorktree = {
  id: 'w1',
  projectId: DEFAULT_PROJECT.id,
  branch: 'feature/login',
  path: WORKTREE_PATH,
  baseRef: 'main',
  createdAt: '2026-09-28T09:00:00.000Z',
  position: { x: 0, y: 0 },
  width: 1200,
  height: 800
}

function chat(
  id: string,
  kind: 'claude' | 'codex',
  overrides: Partial<WorkspaceTerminalNode> = {}
): WorkspaceTerminalNode {
  return {
    id,
    kind,
    label: `${kind} ${id}`,
    projectId: DEFAULT_PROJECT.id,
    worktreeId: 'w1',
    placement: 'worktree',
    position: { x: 0, y: 0 },
    width: 520,
    height: 340,
    conversationId: `conversation-${id}`,
    ...overrides
  }
}

function canvasNodes(id: string): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(`.react-flow__node[data-id="${id}"]`)]
}

function insideWorktree(id: string): boolean {
  const shown = canvasNodes(id)
  return shown.length === 1 && shown[0].closest('.worktree-canvas') !== null
}

function onMainCanvas(id: string): boolean {
  const shown = canvasNodes(id)
  return shown.length === 1 && shown[0].closest('.worktree-canvas') === null
}

interface Mounted {
  harness: AppHarness
  create: ReturnType<typeof vi.fn>
  remove: ReturnType<typeof vi.fn>
  worktreeCreate: ReturnType<typeof vi.fn>
}

async function mount(
  state: WorkspaceState,
  options: {
    discover?: () => Promise<WorktreeDiscoverResult>
    remove?: () => Promise<WorktreeRemoveResult>
    history?: ConversationSummary[]
  } = {}
): Promise<Mounted> {
  // Both providers report the fork capability, as the verified adapters do.
  const agent = createMockAgentApi({
    create: vi.fn(async () => ({ ok: true, status: 'ready' as const, forkSupport: true }))
  })
  const remove = vi.fn(options.remove ?? (async () => ({ ok: true, blockers: [] })))
  const worktreeCreate = vi.fn(async () => ({
    ok: true,
    worktree: { branch: 'toucan/handoff', path: 'D:\\Development\\Toucan-worktrees\\handoff', baseRef: 'main' }
  }))
  const history = options.history ?? []
  const harness = await renderApp({
    state,
    apis: {
      agentApi: agent.api as unknown as Record<string, unknown>,
      worktreeApi: {
        discover: vi.fn(options.discover ?? (async () => ({ worktrees: [], claims: [] }))),
        status: vi.fn(async () => null),
        remove,
        create: worktreeCreate
      },
      conversationApi: {
        list: vi.fn(async () => ({ entries: history, total: history.length, hasMore: false })),
        exists: vi.fn(async () => true)
      }
    }
  })
  return { harness, create: agent.api.create as ReturnType<typeof vi.fn>, remove, worktreeCreate }
}

function createRequests(create: ReturnType<typeof vi.fn>): AgentCreateRequest[] {
  return create.mock.calls.map(([request]) => request as AgentCreateRequest)
}

function lastSaved(harness: AppHarness): WorkspaceState {
  const snapshot = harness.saved.at(-1)
  if (!snapshot) throw new Error('nothing was saved')
  return snapshot
}

/** Picks a chat the way a click does, then closes it with the canvas's own Delete key. */
function closeWithDeleteKey(id: string): void {
  fireEvent.click(canvasNodes(id)[0].querySelector('.node-header') ?? canvasNodes(id)[0])
  fireEvent.keyDown(document.body, { key: 'Delete' })
}

function reopenLastClosed(): void {
  fireEvent.keyDown(window, { key: 'T', ctrlKey: true, shiftKey: true })
}

function historyEntry(overrides: Partial<ConversationSummary>): ConversationSummary {
  return {
    id: 'conversation-history',
    provider: 'codex',
    path: 'C:\\transcripts\\conversation-history.jsonl',
    title: 'Fix the login redirect',
    updatedAt: new Date(Date.now() - 60 * 60_000).toISOString(),
    messageCount: 4,
    cwd: WORKTREE_PATH,
    ...overrides
  }
}

function historyDialog(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.conversation-history-dialog')
}

async function openFromHistory(title: string): Promise<void> {
  // The shortcut is live once the workspace has loaded; pressing it again while open changes nothing.
  await waitFor(() => {
    if (!historyDialog()) fireEvent.keyDown(window, { key: 'h', ctrlKey: true })
    expect(historyDialog()).not.toBeNull()
  })
  fireEvent.click(await within(historyDialog()!).findByText(title))
  await waitFor(() => expect(historyDialog()).toBeNull())
}

/** Header actions of a node React Flow has not measured yet are hidden from role queries. */
function removeButton(): HTMLElement {
  return document.querySelector<HTMLElement>('.worktree-remove')!
}

describe('opening a conversation keeps it inside its worktree', () => {
  test('a branch of a worktree chat opens beside it on the same canvas, as a fork in the same checkout', async () => {
    const { harness, create } = await mount(savedWorkspace({ nodes: [chat('a', 'claude')], worktrees: [worktree] }))
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1))

    const branch = await waitFor(() => {
      const button = canvasNodes('a')[0].querySelector<HTMLElement>('[aria-label="Branch conversation"]')
      expect(button).toBeEnabled()
      return button!
    })
    fireEvent.click(branch)

    await waitFor(() => expect(create).toHaveBeenCalledTimes(2))
    expect(createRequests(create)[1]).toMatchObject({ provider: 'claude', cwd: WORKTREE_PATH })
    await waitFor(() => expect(lastSaved(harness).nodes).toHaveLength(2))
    const child = lastSaved(harness).nodes.find((node) => node.id !== 'a')!
    expect(child).toMatchObject({ worktreeId: 'w1', placement: 'worktree' })
    expect(child.branchedFrom).toEqual({ nodeId: 'a', conversationId: 'conversation-a' })
    expect(insideWorktree(child.id)).toBe(true)
    expect(child.position.x).toBeGreaterThanOrEqual(520)
  })

  test('History opens a worktree conversation on that worktree canvas, and a second open focuses it', async () => {
    const { harness, create } = await mount(savedWorkspace({ worktrees: [worktree] }), {
      history: [historyEntry({})]
    })

    await openFromHistory('Fix the login redirect')

    await waitFor(() => expect(create).toHaveBeenCalledTimes(1))
    expect(createRequests(create)[0]).toMatchObject({
      provider: 'codex',
      cwd: WORKTREE_PATH,
      sessionId: 'conversation-history'
    })
    await waitFor(() => expect(lastSaved(harness).nodes).toHaveLength(1))
    const opened = lastSaved(harness).nodes[0]
    expect(opened).toMatchObject({ worktreeId: 'w1', placement: 'worktree', conversationId: 'conversation-history' })
    expect(insideWorktree(opened.id)).toBe(true)

    // One writer per conversation: the second open is a focus, not a second resume.
    await openFromHistory('Fix the login redirect')
    expect(create).toHaveBeenCalledTimes(1)
    expect(lastSaved(harness).nodes).toHaveLength(1)
  })

  test('a History entry from a worktree no longer on the canvas is refused rather than opened in the project checkout', async () => {
    const { harness, create } = await mount(savedWorkspace({ worktrees: [worktree] }), {
      history: [historyEntry({ cwd: 'D:\Development\Toucan-worktrees\removed-since' })]
    })

    await openFromHistory('Fix the login redirect')

    expect(await screen.findByText('Worktree no longer available')).toBeInTheDocument()
    expect(create).not.toHaveBeenCalled()
    expect(harness.saved.every((snapshot) => snapshot.nodes.length === 0)).toBe(true)
  })

  test('a late claim moves a resting Codex chat into its worktree and leaves a Claude chat where it runs', async () => {
    const codex = chat('codex-main', 'codex', {
      worktreeId: undefined,
      placement: undefined,
      position: { x: 1400, y: 0 }
    })
    const claude = chat('claude-main', 'claude', {
      worktreeId: undefined,
      placement: undefined,
      position: { x: 1400, y: 500 }
    })
    // The claims the agents wrote, found by the first sweep - which runs while both chats are
    // still starting, so the move waits for the boundary rather than happening on discovery.
    const claims = [
      { nodeId: 'codex-main', path: WORKTREE_PATH },
      { nodeId: 'claude-main', path: WORKTREE_PATH }
    ]
    const { harness, create } = await mount(savedWorkspace({ nodes: [codex, claude], worktrees: [worktree] }), {
      discover: async () => ({ worktrees: [], claims })
    })

    await waitFor(() => expect(insideWorktree('codex-main')).toBe(true))

    // The Codex chat resumed its own conversation in the worktree; the Claude chat, whose transcript
    // cannot follow it, kept running in the project checkout and on the main canvas.
    await waitFor(() => expect(create).toHaveBeenCalledTimes(3))
    expect(createRequests(create)[2]).toMatchObject({
      provider: 'codex',
      cwd: WORKTREE_PATH,
      sessionId: 'conversation-codex-main'
    })
    expect(onMainCanvas('claude-main')).toBe(true)
    await waitFor(() =>
      expect(lastSaved(harness).nodes.find((node) => node.id === 'codex-main')).toMatchObject({
        worktreeId: 'w1',
        placement: 'worktree'
      })
    )
    expect(lastSaved(harness).nodes.find((node) => node.id === 'claude-main')?.worktreeId).toBeUndefined()
  })

  test('a worktree handoff from an empty chat moves that chat into the new worktree rather than leaving it behind', async () => {
    const fresh = chat('fresh', 'claude', {
      worktreeId: undefined,
      placement: undefined,
      position: { x: 1400, y: 0 }
    })
    const { harness, create, worktreeCreate } = await mount(savedWorkspace({ nodes: [fresh] }))
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1))

    const composer = canvasNodes('fresh')[0].querySelector('textarea')!
    fireEvent.change(composer, { target: { value: '/implement-in-worktree tidy the login form' } })
    fireEvent.keyDown(composer, { key: 'Enter' })

    await waitFor(() => expect(worktreeCreate).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(insideWorktree('fresh')).toBe(true))
    // One chat, in the worktree, started there as a new conversation carrying the prompt.
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2))
    const moved = createRequests(create)[1]
    expect(moved).toMatchObject({ provider: 'claude', cwd: 'D:\\Development\\Toucan-worktrees\\handoff' })
    await waitFor(() => expect(lastSaved(harness).nodes).toHaveLength(1))
    expect(lastSaved(harness).nodes[0]).toMatchObject({ id: 'fresh', placement: 'worktree' })
    expect(lastSaved(harness).worktrees).toHaveLength(1)
  })
})

describe('closing a chat is the per-node close, never a removal', () => {
  for (const provider of ['claude', 'codex'] as const) {
    test(`closing the last ${provider} chat leaves the worktree and its Add chat; Ctrl+Shift+T brings it back inside`, async () => {
      const { harness, create, remove } = await mount(
        savedWorkspace({ nodes: [chat('a', provider)], worktrees: [worktree] })
      )
      await waitFor(() => expect(create).toHaveBeenCalledTimes(1))

      closeWithDeleteKey('a')

      await waitFor(() => expect(canvasNodes('a')).toHaveLength(0))
      expect(screen.getByText('No chats in this worktree yet.')).toBeInTheDocument()
      expect(screen.getByTitle('New Codex session in this worktree')).toBeEnabled()
      expect(screen.getByTitle('New Claude session in this worktree')).toBeEnabled()
      expect(remove).not.toHaveBeenCalled()
      await waitFor(() => expect(lastSaved(harness).recentlyClosedNodes?.map((node) => node.id)).toEqual(['a']))
      expect(lastSaved(harness).worktrees.map((saved) => saved.id)).toEqual(['w1'])

      reopenLastClosed()

      await waitFor(() => expect(insideWorktree('a')).toBe(true))
      await waitFor(() => expect(create).toHaveBeenCalledTimes(2))
      expect(createRequests(create)[1]).toMatchObject({ provider, cwd: WORKTREE_PATH, sessionId: 'conversation-a' })
      await waitFor(() =>
        expect(lastSaved(harness).nodes).toEqual([
          expect.objectContaining({ id: 'a', worktreeId: 'w1', placement: 'worktree', position: { x: 0, y: 0 } })
        ])
      )
    })
  }

  test('a closed chat reopened from History first is focused by Ctrl+Shift+T, never resumed twice', async () => {
    const { harness, create } = await mount(savedWorkspace({ nodes: [chat('a', 'codex')], worktrees: [worktree] }), {
      history: [historyEntry({ id: 'conversation-a', title: 'The closed one' })]
    })
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1))
    closeWithDeleteKey('a')
    await waitFor(() => expect(canvasNodes('a')).toHaveLength(0))

    await openFromHistory('The closed one')
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2))

    reopenLastClosed()

    await waitFor(() => expect(lastSaved(harness).recentlyClosedNodes ?? []).toEqual([]))
    expect(create).toHaveBeenCalledTimes(2)
    expect(lastSaved(harness).nodes.filter((node) => node.conversationId === 'conversation-a')).toHaveLength(1)
  })
})

describe('removing a worktree keeps its evidence-based gate', () => {
  test('an attached chat blocks removal without asking git, and unprovable evidence never deletes', async () => {
    const { create, remove } = await mount(savedWorkspace({ nodes: [chat('a', 'claude')], worktrees: [worktree] }), {
      remove: async () => ({ ok: false, blockers: [{ kind: 'inspection-failed', detail: 'git timed out' }] })
    })
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1))

    fireEvent.click(removeButton())
    expect(await screen.findByText('1 node is still attached to this worktree')).toBeInTheDocument()
    expect(remove).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))

    closeWithDeleteKey('a')
    await waitFor(() => expect(canvasNodes('a')).toHaveLength(0))
    fireEvent.click(removeButton())

    expect(await screen.findByText(/could not be inspected, so nothing was removed/)).toBeInTheDocument()
    expect(remove).toHaveBeenCalledTimes(1)
    // Blocked outright: nothing in the dialog can force a removal the evidence did not support.
    expect(screen.queryByRole('button', { name: /Remove worktree|Remove and discard/ })).toBeNull()
    // Refused: the worktree is still there, with its Add chat.
    expect(screen.getByTitle('New Claude session in this worktree')).toBeInTheDocument()
  })
})

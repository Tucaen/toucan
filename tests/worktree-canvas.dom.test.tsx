import { fireEvent, screen, waitFor } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import type { AgentCreateRequest } from '../src/shared/agent'
import type { WorkspaceState, WorkspaceTerminalNode } from '../src/shared/workspace'
import type { WorkspaceWorktree } from '../src/shared/worktree'
import { createMockAgentApi } from './dom/agent-api-mock'
import { DEFAULT_PROJECT, renderApp, savedWorkspace, type AppHarness } from './dom/app-harness'

/**
 * Issue #24 end to end, through the real `App`: an attached chat is an ordinary chat node shown on
 * its worktree's own canvas, exactly once; unattached chats stay on the main canvas; the worktree's
 * Add chat actions put ordinary chats of either provider side by side in the same checkout; and a
 * workspace saved before any of this loads into that presentation without a session more or less.
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
  // The size every worktree had before it hosted chats.
  width: 360,
  height: 232
}

/** An attached chat as a build before #24 saved it: beside its worktree, in main-canvas coordinates. */
const legacyChat: WorkspaceTerminalNode = {
  id: 'chat-a',
  kind: 'codex',
  label: 'Codex 1',
  projectId: DEFAULT_PROJECT.id,
  worktreeId: 'w1',
  position: { x: 400, y: 0 },
  width: 520,
  height: 340,
  conversationId: 'conversation-a',
  draft: 'keep this draft'
}

const looseChat: WorkspaceTerminalNode = {
  id: 'loose',
  kind: 'claude',
  label: 'Claude Code 2',
  projectId: DEFAULT_PROJECT.id,
  position: { x: 1200, y: 0 },
  width: 520,
  height: 340,
  conversationId: 'conversation-loose'
}

function canvasNodes(id: string): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(`.react-flow__node[data-id="${id}"]`)]
}

function insideWorktree(element: HTMLElement): boolean {
  return element.closest('.worktree-canvas') !== null
}

async function mount(state: WorkspaceState): Promise<{ harness: AppHarness; create: ReturnType<typeof vi.fn> }> {
  const agent = createMockAgentApi()
  const harness = await renderApp({
    state,
    apis: {
      agentApi: agent.api as unknown as Record<string, unknown>,
      worktreeApi: {
        discover: vi.fn(async () => ({ worktrees: [], claims: [] })),
        status: vi.fn(async () => null)
      }
    }
  })
  return { harness, create: agent.api.create as ReturnType<typeof vi.fn> }
}

function fitChatsButton(): HTMLElement {
  return screen.getByTitle('Frame every chat in this worktree')
}

function createRequests(create: ReturnType<typeof vi.fn>): AgentCreateRequest[] {
  return create.mock.calls.map(([request]) => request as AgentCreateRequest)
}

function lastSaved(harness: AppHarness): WorkspaceState {
  const snapshot = harness.saved.at(-1)
  if (!snapshot) throw new Error('nothing was saved')
  return snapshot
}

describe('a worktree canvas of ordinary chats', () => {
  test('shows an attached chat once, inside its worktree, and leaves an unattached one on the main canvas', async () => {
    const { create } = await mount(savedWorkspace({ nodes: [legacyChat, looseChat], worktrees: [worktree] }))

    await waitFor(() => expect(canvasNodes('chat-a')).toHaveLength(1))
    expect(insideWorktree(canvasNodes('chat-a')[0])).toBe(true)
    expect(canvasNodes('loose')).toHaveLength(1)
    expect(insideWorktree(canvasNodes('loose')[0])).toBe(false)
    // The contained chat is the ordinary chat node, with its own composer and controls.
    expect(canvasNodes('chat-a')[0].querySelector('textarea')).not.toBeNull()

    // One session per chat - restoring into the worktree started nothing extra - and the contained
    // one resumes its own conversation in the worktree directory.
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2))
    expect(createRequests(create)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ provider: 'codex', cwd: WORKTREE_PATH, sessionId: 'conversation-a' }),
        expect.objectContaining({ provider: 'claude', cwd: DEFAULT_PROJECT.path })
      ])
    )
  })

  test('Add chat puts a Codex and a Claude chat side by side in the same checkout, each its own session', async () => {
    const { harness, create } = await mount(savedWorkspace({ nodes: [legacyChat], worktrees: [worktree] }))
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1))

    fireEvent.click(screen.getByTitle('New Codex session in this worktree'))
    fireEvent.click(screen.getByTitle('New Claude session in this worktree'))

    await waitFor(() => expect(create).toHaveBeenCalledTimes(3))
    const added = createRequests(create).slice(1)
    expect(added.map((request) => request.provider)).toEqual(['codex', 'claude'])
    for (const request of added) expect(request.cwd).toBe(WORKTREE_PATH)

    await waitFor(() => {
      const chats = lastSaved(harness).nodes.filter((node) => node.worktreeId === 'w1')
      expect(chats).toHaveLength(3)
    })
    const chats = lastSaved(harness).nodes.filter((node) => node.worktreeId === 'w1')
    // Every chat of the worktree is shown once, inside it, and is placed on its canvas.
    for (const chat of chats) {
      expect(canvasNodes(chat.id)).toHaveLength(1)
      expect(insideWorktree(canvasNodes(chat.id)[0])).toBe(true)
      expect(chat.placement).toBe('worktree')
    }
    // Side by side: one row, left to right, never overlapping.
    const [first, second, third] = chats
    expect(new Set(chats.map((chat) => chat.position.y))).toEqual(new Set([0]))
    expect(second.position.x).toBeGreaterThanOrEqual(first.position.x + first.width)
    expect(third.position.x).toBeGreaterThanOrEqual(second.position.x + second.width)
    // Independent conversations and providers: nothing is shared but the checkout.
    expect(chats.map((chat) => chat.kind)).toEqual(['codex', 'codex', 'claude'])
    expect(chats[2].conversationId).toBeDefined()
    expect(chats[2].conversationId).not.toBe(chats[0].conversationId)
    // The worktree made room for its chats rather than showing them at an unreadable zoom.
    const saved = lastSaved(harness).worktrees[0]
    expect(saved.width).toBeGreaterThanOrEqual(800)
    expect(saved.height).toBeGreaterThanOrEqual(720)
  })

  test('a workspace saved before worktrees held chats keeps every id, conversation and draft on reload', async () => {
    const { harness } = await mount(savedWorkspace({ nodes: [legacyChat, looseChat], worktrees: [worktree] }))

    await waitFor(() => expect(harness.saved.length).toBeGreaterThan(0))
    const saved = lastSaved(harness)
    expect(saved.nodes.map((node) => [node.id, node.conversationId, node.draft ?? null])).toEqual([
      ['chat-a', 'conversation-a', 'keep this draft'],
      ['loose', 'conversation-loose', null]
    ])
    const migrated = saved.nodes[0]
    expect(migrated).toMatchObject({ worktreeId: 'w1', placement: 'worktree', width: 520, height: 340 })
    expect(saved.nodes[1].placement).toBeUndefined()
    expect(saved.nodes[1].position).toEqual(looseChat.position)
    // The worktree took in the area it and its chat covered on the main canvas.
    expect(saved.worktrees[0].position).toEqual({ x: 0, y: 0 })
    expect(saved.worktrees[0].width).toBeGreaterThanOrEqual(920)
    expect(saved.worktrees[0].height).toBeGreaterThanOrEqual(340)
  })

  test('an empty worktree keeps its Add chat actions, and a chat whose worktree is gone stays detached outside', async () => {
    const orphan: WorkspaceTerminalNode = { ...legacyChat, id: 'orphan', worktreeId: 'gone' }
    const { create } = await mount(savedWorkspace({ nodes: [orphan], worktrees: [worktree] }))

    await waitFor(() => expect(canvasNodes('orphan')).toHaveLength(1))
    expect(insideWorktree(canvasNodes('orphan')[0])).toBe(false)
    expect(screen.getByText('No chats in this worktree yet.')).toBeInTheDocument()
    expect(screen.getByTitle('New Codex session in this worktree')).toBeEnabled()
    expect(screen.getByTitle('New Claude session in this worktree')).toBeEnabled()
    expect(fitChatsButton()).toBeDisabled()
    // Detached and dormant: it never silently starts in the project checkout.
    expect(create).not.toHaveBeenCalled()
  })

  test('the compact row carries activity, Add chat and Fit chats, and there is no toolbar above the canvas', async () => {
    await mount(savedWorkspace({ nodes: [legacyChat], worktrees: [worktree] }))
    await waitFor(() => expect(canvasNodes('chat-a')).toHaveLength(1))

    const node = document.querySelector<HTMLElement>('.worktree-node')!
    const row = node.querySelector<HTMLElement>('.worktree-actions')!
    // Header, canvas, row - in that order and nothing else.
    expect(
      [...node.children]
        .map((child) => child.className.split(' ')[0])
        .filter((name) => name.startsWith('worktree') || name === 'node-header')
    ).toEqual(['node-header', 'worktree-canvas', 'worktree-actions'])
    expect(row.querySelector('.worktree-activity')).toHaveTextContent('1 attached')
    expect(row.querySelector('[role="group"][aria-label="Add chat"]')).not.toBeNull()
    expect(row).toContainElement(fitChatsButton())
    expect(screen.queryByRole('button', { name: /details/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /close selected/i })).toBeNull()
  })

  test("a worktree canvas comes back at the viewport it was left at, with its chats' geometry unchanged", async () => {
    const placed: WorkspaceTerminalNode = {
      ...legacyChat,
      placement: 'worktree',
      position: { x: 64, y: 12 },
      width: 610,
      height: 480
    }
    const viewport = { x: -40, y: 10, zoom: 0.5 }
    const { harness } = await mount(
      savedWorkspace({ nodes: [placed], worktrees: [{ ...worktree, width: 900, height: 700, viewport }] })
    )

    await waitFor(() => expect(canvasNodes('chat-a')).toHaveLength(1))
    const inner = document.querySelector<HTMLElement>('.worktree-canvas .react-flow__viewport')!
    expect(inner.style.transform.replace(/\s/g, '')).toBe('translate(-40px,10px)scale(0.5)')

    await waitFor(() => expect(harness.saved.length).toBeGreaterThan(0))
    const saved = lastSaved(harness)
    expect(saved.worktrees[0].viewport).toEqual(viewport)
    expect(saved.nodes[0]).toMatchObject({ placement: 'worktree', position: { x: 64, y: 12 }, width: 610, height: 480 })
  })
})

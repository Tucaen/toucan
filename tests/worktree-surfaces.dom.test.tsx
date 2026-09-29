import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import App from '../src/renderer/src/App'
import type { WorkspaceState, WorkspaceTerminalNode } from '../src/shared/workspace'
import type { WorkspaceWorktree } from '../src/shared/worktree'
import { createMockAgentApi } from './dom/agent-api-mock'
import { DEFAULT_PROJECT, installWindowApis, savedWorkspace, type AppHarness } from './dom/app-harness'
import { installMeasuredLayout } from './dom/measured-layout'

// Real terminal and file nodes mount here; jsdom has neither xterm's canvas nor a file bridge.
vi.mock('@xterm/xterm', async () => (await import('./dom/xterm-mock')).xtermModule())
vi.mock('@xterm/addon-fit', async () => (await import('./dom/xterm-mock')).fitAddonModule())

/**
 * Issue #28 end to end, through the real `App`: a terminal or setup terminal opened in a worktree
 * lands on that worktree's canvas and runs in its directory with its ordinary session lifecycle; a
 * diff review and a file opened for the worktree live there as layout - never as attachment, never
 * as a removal blocker - and go with the worktree when it is removed; lineage stays a projection
 * even when parent and child sit on different canvases; and being inside a worktree beside a
 * terminal grants a chat nothing.
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

function chat(id: string, overrides: Partial<WorkspaceTerminalNode> = {}): WorkspaceTerminalNode {
  return {
    id,
    kind: 'codex',
    label: `codex ${id}`,
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

interface Mounted {
  harness: AppHarness
  terminalCreate: ReturnType<typeof vi.fn>
  terminalWrite: ReturnType<typeof vi.fn>
  removeScrollback: ReturnType<typeof vi.fn>
  replaceEdges: ReturnType<typeof vi.fn>
  remove: ReturnType<typeof vi.fn>
}

let teardownLayout: (() => void) | null = null
afterEach(() => {
  teardownLayout?.()
  teardownLayout = null
})

async function mount(state: WorkspaceState, agent = createMockAgentApi()): Promise<Mounted> {
  const terminalCreate = vi.fn(async (request: { sessionId?: string }) => ({
    ok: true,
    sessionId: request.sessionId,
    incarnationId: `incarnation-${request.sessionId}`,
    liveness: 'live'
  }))
  const terminalWrite = vi.fn()
  const removeScrollback = vi.fn(async () => true)
  const replaceEdges = vi.fn()
  const remove = vi.fn(async () => ({ ok: true, blockers: [] }))
  const harness = installWindowApis({
    state,
    apis: {
      agentApi: agent.api as unknown as Record<string, unknown>,
      terminalApi: { create: terminalCreate, write: terminalWrite, removeScrollback },
      terminalContextApi: { replaceEdges },
      fileViewApi: {
        read: vi.fn(async () => ({
          ok: true,
          content: '# readme',
          truncated: false,
          binary: false,
          mtime: 'mtime-1',
          size: 8,
          lineEnding: 'lf'
        })),
        write: vi.fn(),
        watch: vi.fn(async () => undefined),
        unwatch: vi.fn(async () => undefined),
        onChange: () => () => undefined
      },
      worktreeApi: {
        discover: vi.fn(async () => ({ worktrees: [], claims: [] })),
        status: vi.fn(async () => null),
        remove,
        diff: vi.fn(async () => ({ ok: true, files: [] })),
        diffFile: vi.fn(async () => ({ ok: true, hunks: [] }))
      }
    }
  })
  // A measured layout, so React Flow initializes its nodes and actually draws edges in jsdom.
  teardownLayout = installMeasuredLayout({ width: 1920, height: 1000 })
  render(<App />)
  await screen.findByText('Add project')
  return { harness, terminalCreate, terminalWrite, removeScrollback, replaceEdges, remove }
}

function lastSaved(harness: AppHarness): WorkspaceState {
  const snapshot = harness.saved.at(-1)
  if (!snapshot) throw new Error('nothing was saved')
  return snapshot
}

function closeWithDeleteKey(id: string): void {
  fireEvent.click(canvasNodes(id)[0].querySelector('.node-header') ?? canvasNodes(id)[0])
  fireEvent.keyDown(document.body, { key: 'Delete' })
}

describe('a terminal opened in a worktree is that worktree’s', () => {
  test('the header terminal action opens it on the worktree canvas, in the worktree directory', async () => {
    const { harness, terminalCreate, removeScrollback, remove } = await mount(
      savedWorkspace({ nodes: [chat('a')], worktrees: [worktree] })
    )

    fireEvent.click(await screen.findByLabelText('New terminal in this worktree'))

    // The process runs in the worktree, keyed by the node's own durable session id.
    await waitFor(() => expect(terminalCreate).toHaveBeenCalledTimes(1))
    const request = terminalCreate.mock.calls[0][0] as { cwd?: string; sessionId?: string }
    expect(request.cwd).toBe(WORKTREE_PATH)
    expect(request.sessionId).toBeTruthy()

    // Placed inside the worktree and persisted that way, beside the chat already there.
    const saved = await waitFor(() => {
      const node = lastSaved(harness).nodes.find((candidate) => candidate.kind === 'terminal')
      expect(node).toBeTruthy()
      return node!
    })
    expect(saved).toMatchObject({ worktreeId: 'w1', placement: 'worktree', sessionId: request.sessionId })
    expect(saved.position.x).toBeGreaterThanOrEqual(520)
    expect(insideWorktree(saved.id)).toBe(true)

    // Closing it is the terminal's own cleanup - scrollback retired with the node - and says
    // nothing about the worktree: no removal ran, the chat is untouched.
    closeWithDeleteKey(saved.id)
    await waitFor(() => expect(canvasNodes(saved.id)).toHaveLength(0))
    await waitFor(() => expect(removeScrollback).toHaveBeenCalledWith(request.sessionId))
    expect(remove).not.toHaveBeenCalled()
    expect(insideWorktree('a')).toBe(true)
    await waitFor(() => expect(lastSaved(harness).nodes.map((node) => node.id)).toEqual(['a']))
  })

  test('the setup command opens a visible terminal inside the worktree and types the command', async () => {
    const { harness, terminalCreate, terminalWrite } = await mount(
      savedWorkspace({
        projects: [{ ...DEFAULT_PROJECT, setupCommand: 'npm install' }],
        nodes: [chat('a')],
        worktrees: [worktree]
      })
    )

    // Header actions of a node React Flow has not measured yet are hidden from role queries.
    const setup = await waitFor(() => {
      const button = document.querySelector<HTMLButtonElement>('.worktree-setup')
      expect(button).not.toBeNull()
      expect(button!.disabled).toBe(false)
      return button!
    })
    fireEvent.click(setup)

    await waitFor(() => expect(terminalCreate).toHaveBeenCalledTimes(1))
    expect(terminalCreate.mock.calls[0][0]).toMatchObject({ cwd: WORKTREE_PATH })
    // The command is typed into the visible terminal, whichever seam carries it there.
    const typed = [
      JSON.stringify(terminalCreate.mock.calls[0][0]),
      ...terminalWrite.mock.calls.map((call) => JSON.stringify(call))
    ].join('\n')
    expect(typed).toContain('npm install')
    const saved = await waitFor(() => {
      const node = lastSaved(harness).nodes.find((candidate) => candidate.kind === 'terminal')
      expect(node).toBeTruthy()
      return node!
    })
    expect(saved).toMatchObject({ worktreeId: 'w1', placement: 'worktree' })
    expect(insideWorktree(saved.id)).toBe(true)
  })
})

describe('review surfaces live with the worktree and never bind it', () => {
  test('Diff opens the review inside the worktree; removal takes the review and file along, not the checkout gate', async () => {
    const { harness, remove } = await mount(
      savedWorkspace({
        worktrees: [worktree],
        files: [
          {
            id: 'file-w',
            projectId: DEFAULT_PROJECT.id,
            worktreeId: 'w1',
            path: `${WORKTREE_PATH}\\README.md`,
            view: 'rendered',
            position: { x: 0, y: 400 },
            width: 480,
            height: 360
          }
        ]
      })
    )

    // The seeded file renders inside the worktree canvas.
    await waitFor(() => expect(insideWorktree('file-w')).toBe(true))

    fireEvent.click(await screen.findByTitle("Review this worktree's changes against main"))

    const savedDiff = await waitFor(() => {
      const diff = lastSaved(harness).diffs?.[0]
      expect(diff).toBeTruthy()
      return diff!
    })
    expect(savedDiff).toMatchObject({ worktreeId: 'w1', placement: 'worktree' })
    expect(insideWorktree(savedDiff.id)).toBe(true)

    // Neither the review nor the file counts as attached, so removal runs its evidence check
    // instead of opening blocked - a clean checkout with no attached sessions removes directly.
    fireEvent.click(document.querySelector<HTMLElement>('.worktree-remove')!)
    await waitFor(() => expect(remove).toHaveBeenCalledTimes(1))
    // The worktree's surfaces go with it: no orphaned review of a directory that no longer exists.
    await waitFor(() => expect(canvasNodes(savedDiff.id)).toHaveLength(0))
    expect(canvasNodes('file-w')).toHaveLength(0)
    await waitFor(() => {
      const saved = lastSaved(harness)
      expect(saved.worktrees).toEqual([])
      expect(saved.diffs ?? []).toEqual([])
      expect(saved.files ?? []).toEqual([])
    })
  })
})

describe('relationships across canvas boundaries', () => {
  test('a branch across canvases keeps its provenance and can reveal its parent without granting access', async () => {
    const parent = chat('parent', { worktreeId: undefined, placement: undefined, position: { x: 1400, y: 0 } })
    const child = chat('child', { branchedFrom: { nodeId: 'parent', conversationId: 'conversation-parent' } })
    const sibling = chat('sibling', {
      position: { x: 560, y: 0 },
      branchedFrom: { nodeId: 'child', conversationId: 'conversation-child' }
    })
    const { harness, replaceEdges } = await mount(
      savedWorkspace({ nodes: [parent, child, sibling], worktrees: [worktree] })
    )

    await waitFor(() => expect(insideWorktree('child')).toBe(true))
    expect(insideWorktree('sibling')).toBe(true)
    expect(canvasNodes('parent')[0].closest('.worktree-canvas')).toBeNull()

    // Same canvas: the projection is drawn inside the worktree. Across canvases: not drawn at
    // all, and never turned into state that something could revoke or delete.
    await waitFor(() => {
      const drawn = document.querySelector('[data-id="lineage:child->sibling"]')
      expect(drawn).not.toBeNull()
      expect(drawn!.closest('.worktree-canvas')).not.toBeNull()
    })
    expect(document.querySelector('[data-id="lineage:parent->child"]')).toBeNull()

    // The provenance record itself survives untouched on the child, wherever its parent sits.
    await waitFor(() => expect(harness.saved.length).toBeGreaterThan(0))
    const savedChild = lastSaved(harness).nodes.find((node) => node.id === 'child')!
    expect(savedChild.branchedFrom).toEqual({ nodeId: 'parent', conversationId: 'conversation-parent' })

    fireEvent.click(screen.getByRole('button', { name: 'Connections for codex child (2)' }))
    const dialog = screen.getByRole('dialog', { name: 'Connections for codex child' })
    expect(within(dialog).getByText('Branched from: codex parent')).toBeTruthy()
    expect(within(dialog).queryByRole('button', { name: /Connect codex/ })).toBeNull()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Show codex parent' }))
    await waitFor(() => expect(canvasNodes('parent')[0].classList.contains('selected')).toBe(true))
    expect(replaceEdges).toHaveBeenLastCalledWith([])
  })

  test('sharing a worktree with a terminal grants a chat nothing: the mirrored grant set stays empty', async () => {
    const terminal = chat('term', {
      kind: 'terminal',
      label: 'Terminal',
      sessionId: 'session-term',
      conversationId: undefined,
      position: { x: 560, y: 0 }
    })
    const { replaceEdges } = await mount(savedWorkspace({ nodes: [chat('a'), terminal], worktrees: [worktree] }))

    await waitFor(() => expect(insideWorktree('term')).toBe(true))
    expect(insideWorktree('a')).toBe(true)

    // The registry mirror is the renderer's whole authority over grants, and it was only ever
    // handed the empty set: containment is not an edge.
    await waitFor(() => expect(replaceEdges).toHaveBeenCalled())
    for (const call of replaceEdges.mock.calls) expect(call[0]).toEqual([])
  })

  test.each(['w1', 'w2', undefined])(
    'a terminal feeds a chat on canvas %s until explicitly revoked or closed',
    async (targetWorktree) => {
      const terminal = chat('term', {
        kind: 'terminal',
        label: 'Terminal',
        sessionId: 'session-term',
        conversationId: undefined,
        position: { x: 560, y: 0 }
      })
      const { harness, replaceEdges, removeScrollback } = await mount(
        savedWorkspace({
          nodes: [terminal, chat('a', { worktreeId: targetWorktree })],
          worktrees: [
            worktree,
            {
              ...worktree,
              id: 'w2',
              branch: 'feature/second',
              path: `${WORKTREE_PATH}-second`,
              position: { x: 1300, y: 0 }
            }
          ]
        })
      )
      const opener = await screen.findByRole('button', { name: 'Connections for Terminal (0)' })
      opener.focus()
      fireEvent.click(opener)
      let dialog = screen.getByRole('dialog', { name: 'Connections for Terminal' })
      expect(dialog.contains(document.activeElement)).toBe(true)
      fireEvent.click(within(dialog).getByRole('button', { name: 'Connect codex a' }))
      const grant = [{ terminalSessionId: 'session-term', agentId: 'a' }]
      await waitFor(() => expect(replaceEdges).toHaveBeenLastCalledWith(grant))
      fireEvent.keyDown(dialog, { key: 'Escape' })
      expect(document.activeElement).toBe(opener)

      // Collapse/focus are views: a grant is retained, even when one endpoint is hidden.
      const firstWorktree = document.querySelector<HTMLElement>('.react-flow__node[data-id="worktree:w1"]')!
      fireEvent.click(within(firstWorktree).getByRole('button', { name: 'Collapse worktree' }))
      await waitFor(() => expect(lastSaved(harness).worktrees?.find((item) => item.id === 'w1')?.collapsed).toBe(true))
      expect(replaceEdges).toHaveBeenLastCalledWith(grant)
      fireEvent.click(within(firstWorktree).getByRole('button', { name: 'Expand worktree' }))
      if (targetWorktree === 'w1') {
        await waitFor(() => expect(document.querySelector('[data-id="terminal-context:term->a"]')).not.toBeNull())
      } else {
        expect(document.querySelector('[data-id="terminal-context:term->a"]')).toBeNull()
      }

      // Either endpoint can revoke, even across canvases; no phantom line or cross-canvas drag is needed.
      fireEvent.click(screen.getByRole('button', { name: 'Connections for codex a (1)' }))
      dialog = screen.getByRole('dialog', { name: 'Connections for codex a' })
      fireEvent.click(within(dialog).getByRole('button', { name: 'Disconnect Terminal' }))
      await waitFor(() => expect(replaceEdges).toHaveBeenLastCalledWith([]))
      fireEvent.click(within(dialog).getByRole('button', { name: 'Connect Terminal' }))
      await waitFor(() => expect(replaceEdges).toHaveBeenLastCalledWith(grant))
      fireEvent.click(within(dialog).getByRole('button', { name: 'Done' }))
      closeWithDeleteKey('term')
      await waitFor(() => expect(replaceEdges).toHaveBeenLastCalledWith([]))
      expect(removeScrollback).toHaveBeenCalledWith('session-term')
      // Runtime grants never enter the saved workspace.
      expect(JSON.stringify(lastSaved(harness))).not.toContain('terminal-context:')
    }
  )

  test('cross-canvas access restarts a running chat only at its next safe boundary', async () => {
    let launches = 0
    const agent = createMockAgentApi({
      create: vi.fn(async () => ({
        ok: true,
        status: 'ready',
        conversationId: 'conversation-a',
        terminalContext: ++launches > 1
      }))
    })
    const terminal = chat('term', {
      kind: 'terminal',
      label: 'Terminal',
      sessionId: 'session-term',
      conversationId: undefined
    })
    const { replaceEdges } = await mount(
      savedWorkspace({
        nodes: [terminal, chat('a', { worktreeId: undefined, placement: undefined })],
        worktrees: [worktree]
      }),
      agent
    )
    const open = within(canvasNodes('a')[0]).queryByRole('button', { name: 'Open conversation' })
    if (open) fireEvent.click(open)
    await waitFor(() => expect(launches).toBe(1))
    act(() => agent.emit('a', { type: 'status', status: 'working' }))
    fireEvent.click(screen.getByRole('button', { name: 'Connections for codex a (0)' }))
    fireEvent.click(screen.getByRole('button', { name: 'Connect Terminal' }))
    await waitFor(() =>
      expect(replaceEdges).toHaveBeenLastCalledWith([{ terminalSessionId: 'session-term', agentId: 'a' }])
    )
    expect(launches).toBe(1)
    act(() => agent.emit('a', { type: 'status', status: 'ready' }))
    await waitFor(() => expect(launches).toBe(2))
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect Terminal' }))
    await waitFor(() => expect(replaceEdges).toHaveBeenLastCalledWith([]))
    expect(launches).toBe(2)
  })
})

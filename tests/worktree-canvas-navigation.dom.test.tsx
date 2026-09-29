import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import App from '../src/renderer/src/App'
import { NODE_FIT_INSET } from '../src/renderer/src/node-snap'
import type { WorkspaceState, WorkspaceTerminalNode } from '../src/shared/workspace'
import type { WorkspaceWorktree } from '../src/shared/worktree'
import { createMockAgentApi } from './dom/agent-api-mock'
import { DEFAULT_PROJECT, installWindowApis, savedWorkspace, type AppHarness } from './dom/app-harness'
import { installMeasuredLayout } from './dom/measured-layout'

/**
 * Issue #25, through the real `App` with a measured layout: every layout command lands on the
 * canvas the selection is on. Two worktrees with chats and a chat on the main canvas are the
 * fixture, so a shortcut aimed at one worktree's chat has three wrong places it could go.
 */

const PANE = { width: 1600, height: 900 }
const INSET = NODE_FIT_INSET

/** The usable region of a worktree canvas at zoom 1, origin: its node's size less chrome and insets. */
const W1 = { width: 900, height: 700 }
const W1_REGION = { x: INSET, y: INSET, width: W1.width - INSET * 2, height: W1.height - 76 - INSET * 2 }

function worktree(id: string, branch: string, x: number): WorkspaceWorktree {
  return {
    id,
    projectId: DEFAULT_PROJECT.id,
    branch,
    path: `D:\\Development\\Toucan-worktrees\\${id}`,
    baseRef: 'main',
    createdAt: '2026-09-28T09:00:00.000Z',
    position: { x, y: 0 },
    width: W1.width,
    height: W1.height,
    viewport: { x: 0, y: 0, zoom: 1 }
  }
}

function chat(id: string, label: string, worktreeId: string | undefined, x: number): WorkspaceTerminalNode {
  return {
    id,
    kind: 'codex',
    label,
    projectId: DEFAULT_PROJECT.id,
    ...(worktreeId ? { worktreeId, placement: 'worktree' as const } : {}),
    position: { x, y: 0 },
    width: 520,
    height: 340,
    conversationId: `conversation-${id}`
  }
}

const fixture = (): WorkspaceState =>
  savedWorkspace({
    worktrees: [worktree('w1', 'feature/login', 0), worktree('w2', 'feature/signup', 1000)],
    nodes: [
      chat('a1', 'Chat A1', 'w1', 0),
      chat('a2', 'Chat A2', 'w1', 560),
      chat('b1', 'Chat B1', 'w2', 0),
      chat('loose', 'Loose chat', undefined, 2000)
    ]
  })

let teardownLayout: () => void = () => undefined

afterEach(() => teardownLayout())

async function mount(state: WorkspaceState = fixture()): Promise<AppHarness> {
  const agent = createMockAgentApi()
  const harness = installWindowApis({
    state,
    apis: { agentApi: agent.api as unknown as Record<string, unknown> }
  })
  // After the bridges, whose ResizeObserver stub it replaces; before the render it measures.
  teardownLayout = installMeasuredLayout(PANE)
  render(<App />)
  await screen.findByText('Add project')
  await waitFor(() => expect(nodeElement('loose')).not.toBeNull())
  return harness
}

function nodeElement(id: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"]`)
}

function select(id: string): void {
  fireEvent.click(nodeElement(id)!)
}

function lastSaved(harness: AppHarness): WorkspaceState {
  const snapshot = harness.saved.at(-1)
  if (!snapshot) throw new Error('nothing was saved')
  return snapshot
}

function savedNode(harness: AppHarness, id: string): WorkspaceTerminalNode {
  const node = lastSaved(harness).nodes.find((candidate) => candidate.id === id)
  if (!node) throw new Error(`${id} was not saved`)
  return node
}

function geometry(node: { position: { x: number; y: number }; width: number; height: number }): unknown {
  return { x: node.position.x, y: node.position.y, width: node.width, height: node.height }
}

async function saved(harness: AppHarness, id: string, expected: unknown): Promise<void> {
  await waitFor(() => expect(geometry(savedNode(harness, id))).toEqual(expected))
}

function geometryOf(nodes: readonly WorkspaceTerminalNode[], id: string): unknown {
  const node = nodes.find((candidate) => candidate.id === id)
  return node ? geometry(node) : undefined
}

/** What React Flow renders for a node right now: its wrapper's inline size and its transform. */
function shown(id: string): unknown {
  const element = nodeElement(id)!
  const [, x, y] = /translate\(\s*([-\d.]+)px,\s*([-\d.]+)px\)/.exec(element.style.transform) ?? []
  return {
    x: Number(x),
    y: Number(y),
    width: Number.parseFloat(element.style.width),
    height: Number.parseFloat(element.style.height)
  }
}

const UNMOVED = {
  a1: { x: 0, y: 0, width: 520, height: 340 },
  a2: { x: 560, y: 0, width: 520, height: 340 },
  b1: { x: 0, y: 0, width: 520, height: 340 },
  loose: { x: 2000, y: 0, width: 520, height: 340 }
}

describe('layout commands land on the canvas the selection is on', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  test('Alt+Up on a chat selected inside a worktree fills that worktree and moves nothing elsewhere', async () => {
    const harness = await mount()
    select('a1')
    fireEvent.keyDown(window, { key: 'ArrowUp', code: 'ArrowUp', altKey: true })

    await waitFor(() => expect(shown('a1')).toEqual(W1_REGION))
    expect(shown('a2')).toEqual(UNMOVED.a2)
    expect(shown('b1')).toEqual(UNMOVED.b1)
    expect(shown('loose')).toEqual(UNMOVED.loose)
    expect(shown('worktree:w1')).toEqual({ x: 0, y: 0, width: 900, height: 700 })
    expect(shown('worktree:w2')).toEqual({ x: 1000, y: 0, width: 900, height: 700 })
    // The header offers Restore on that chat and nothing else.
    expect(within(nodeElement('a1')!).getByRole('button', { name: 'Restore' })).toBeInTheDocument()
    expect(within(nodeElement('a2')!).queryByRole('button', { name: 'Restore' })).toBeNull()
    // A maximised chat is a way of looking at it, not an arrangement: no snapshot carries it.
    for (const snapshot of harness.saved) expect(geometryOf(snapshot.nodes, 'a1')).toEqual(UNMOVED.a1)

    fireEvent.keyDown(window, { key: 'ArrowDown', code: 'ArrowDown', altKey: true })
    await waitFor(() => expect(shown('a1')).toEqual(UNMOVED.a1))
  })

  test('Alt+Left in a chat composer snaps that chat within its worktree; in a text input it does nothing', async () => {
    const harness = await mount()
    const composer = nodeElement('a2')!.querySelector('textarea')!
    fireEvent.keyDown(composer, { key: 'ArrowLeft', code: 'ArrowLeft', altKey: true })
    await saved(harness, 'a2', { x: INSET, y: INSET, width: (W1_REGION.width - INSET) / 2, height: W1_REGION.height })
    expect(geometry(savedNode(harness, 'a1'))).toEqual(UNMOVED.a1)

    const input = document.createElement('input')
    document.body.appendChild(input)
    fireEvent.keyDown(input, { key: 'ArrowRight', code: 'ArrowRight', altKey: true })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(geometry(savedNode(harness, 'a2'))).toEqual({
      x: INSET,
      y: INSET,
      width: (W1_REGION.width - INSET) / 2,
      height: W1_REGION.height
    })
  })

  test('Ctrl+Shift+A tiles the worktree a chat is selected in, and the main canvas when nothing is', async () => {
    const harness = await mount()
    select('b1')
    // One chat in w2: it takes the whole region.
    fireEvent.keyDown(window, { key: 'a', code: 'KeyA', ctrlKey: true, shiftKey: true })
    await saved(harness, 'b1', W1_REGION)
    expect(geometry(savedNode(harness, 'a1'))).toEqual(UNMOVED.a1)
    expect(geometry(savedNode(harness, 'a2'))).toEqual(UNMOVED.a2)
    expect(geometry(savedNode(harness, 'loose'))).toEqual(UNMOVED.loose)

    select('a1')
    fireEvent.keyDown(window, { key: 'a', code: 'KeyA', ctrlKey: true, shiftKey: true })
    const cell = (W1_REGION.width - INSET) / 2
    await saved(harness, 'a1', { x: INSET, y: INSET, width: cell, height: W1_REGION.height })
    expect(geometry(savedNode(harness, 'a2'))).toEqual({
      x: INSET + cell + INSET,
      y: INSET,
      width: cell,
      height: W1_REGION.height
    })
    expect(geometry(savedNode(harness, 'loose'))).toEqual(UNMOVED.loose)
    expect(lastSaved(harness).worktrees[0].position).toEqual({ x: 0, y: 0 })

    // Nothing selected: the main canvas is tiled - the worktrees and the loose chat, as rows, the
    // third mode of the one cycle - and no chat inside a worktree moves.
    fireEvent.click(document.querySelector('.canvas-region > .react-flow .react-flow__pane')!)
    fireEvent.keyDown(window, { key: 'a', code: 'KeyA', ctrlKey: true, shiftKey: true })
    const row = { width: PANE.width - INSET * 2, height: (PANE.height - INSET * 2 - INSET * 2) / 3 }
    await waitFor(() =>
      expect(lastSaved(harness).worktrees.map((record) => geometry(record))).toEqual([
        { x: INSET, y: INSET, ...row },
        { x: INSET, y: INSET + row.height + INSET, ...row }
      ])
    )
    expect(geometry(savedNode(harness, 'loose'))).toEqual({ x: INSET, y: INSET + (row.height + INSET) * 2, ...row })
    expect(geometry(savedNode(harness, 'a1'))).toEqual({ x: INSET, y: INSET, width: cell, height: W1_REGION.height })
    expect(geometry(savedNode(harness, 'b1'))).toEqual(W1_REGION)
  })

  test("a chat's header fit action fills its worktree and its restore returns it, while the snapshot keeps the durable geometry", async () => {
    const harness = await mount()
    fireEvent.click(within(nodeElement('a1')!).getByRole('button', { name: 'Fit to canvas' }))
    // The live chat fills the worktree canvas...
    await waitFor(() => expect(shown('a1')).toEqual(W1_REGION))
    // ...while any workspace snapshot keeps where it will return to. Something else has to change
    // for one to be written at all, since the maximise itself changes nothing durable.
    select('loose')
    fireEvent.keyDown(window, { key: 'ArrowLeft', code: 'ArrowLeft', altKey: true })
    await waitFor(() => expect(harness.saved.length).toBeGreaterThan(0))
    for (const snapshot of harness.saved) expect(geometryOf(snapshot.nodes, 'a1')).toEqual(UNMOVED.a1)

    fireEvent.click(within(nodeElement('a1')!).getByRole('button', { name: 'Restore' }))
    await waitFor(() => expect(shown('a1')).toEqual(UNMOVED.a1))
    expect(geometry(savedNode(harness, 'a1'))).toEqual(UNMOVED.a1)
  })

  test('focusing a chat from the sidebar pans its worktree canvas to it as well as the main canvas', async () => {
    await mount()
    fireEvent.click(screen.getByTitle(/^Focus Chat A2/))
    const inner = nodeElement('a2')!.closest('.worktree-canvas')!.querySelector<HTMLElement>('.react-flow__viewport')!
    // Centred in the 900x624 canvas at zoom 1: (900-520)/2 - 560 = -370, (624-340)/2 = 142.
    await waitFor(() => expect(inner.style.transform.replace(/\s/g, '')).toBe('translate(-370px,142px)scale(1)'), {
      timeout: 2000
    })
    const outer = document.querySelector<HTMLElement>('.canvas-region > .react-flow .react-flow__viewport')!
    // The main canvas centred the worktree that shows it: (1600-900)/2 = 350, (900-700)/2 = 100.
    expect(outer.style.transform.replace(/\s/g, '')).toBe('translate(350px,100px)scale(1)')
  })
})

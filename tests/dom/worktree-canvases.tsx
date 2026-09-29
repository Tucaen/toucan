import { render, screen, waitFor } from '@testing-library/react'
import { expect } from 'vitest'
import App from '../../src/renderer/src/App'
import { NODE_FIT_INSET } from '../../src/renderer/src/node-snap'
import { WORKTREE_CHROME_HEIGHT } from '../../src/renderer/src/canvas-workspace'
import type { WorkspaceState, WorkspaceTerminalNode } from '../../src/shared/workspace'
import type { WorkspaceWorktree } from '../../src/shared/worktree'
import { createMockAgentApi, type MockAgentApi } from './agent-api-mock'
import { DEFAULT_PROJECT, installWindowApis, savedWorkspace, type AppHarness } from './app-harness'
import { installMeasuredLayout, resizeObservedWithin } from './measured-layout'

/**
 * The fixture the worktree navigation tests (#25) share: two worktrees of chats and a chat on the
 * main canvas, mounted through the real `App` with a measured layout, so a gesture or shortcut
 * aimed at one worktree's chat has three wrong places it could land.
 */

export const PANE = { width: 1600, height: 900 }
export const INSET = NODE_FIT_INSET
/** Every worktree in the fixture is this size, with its canvas at zoom 1 from the origin. */
export const WORKTREE_SIZE = { width: 900, height: 700 }
/** The usable region of one of those worktree canvases, in its own coordinates. */
export const WORKTREE_REGION = {
  x: INSET,
  y: INSET,
  width: WORKTREE_SIZE.width - INSET * 2,
  height: WORKTREE_SIZE.height - WORKTREE_CHROME_HEIGHT - INSET * 2
}
export const CHAT_SIZE = { width: 520, height: 340 }

export function worktree(
  id: string,
  branch: string,
  x: number,
  extra: Partial<WorkspaceWorktree> = {}
): WorkspaceWorktree {
  return {
    id,
    projectId: DEFAULT_PROJECT.id,
    branch,
    path: `D:\\Development\\Toucan-worktrees\\${id}`,
    baseRef: 'main',
    createdAt: '2026-09-28T09:00:00.000Z',
    position: { x, y: 0 },
    ...WORKTREE_SIZE,
    viewport: { x: 0, y: 0, zoom: 1 },
    ...extra
  }
}

export function chat(id: string, label: string, worktreeId: string | undefined, x: number): WorkspaceTerminalNode {
  return {
    id,
    kind: 'codex',
    label,
    projectId: DEFAULT_PROJECT.id,
    ...(worktreeId ? { worktreeId, placement: 'worktree' as const } : {}),
    position: { x, y: 0 },
    ...CHAT_SIZE,
    conversationId: `conversation-${id}`
  }
}

/** `w1` holds `a1` and `a2` side by side, `w2` holds `b1`, and `loose` sits on the main canvas. */
export function twoWorktrees(overrides: Partial<WorkspaceState> = {}): WorkspaceState {
  return savedWorkspace({
    worktrees: [worktree('w1', 'feature/login', 0), worktree('w2', 'feature/signup', 1000)],
    nodes: [
      chat('a1', 'Chat A1', 'w1', 0),
      chat('a2', 'Chat A2', 'w1', 560),
      chat('b1', 'Chat B1', 'w2', 0),
      chat('loose', 'Loose chat', undefined, 2000)
    ],
    ...overrides
  })
}

/** Where the fixture's nodes are until something moves them. */
export const UNMOVED = {
  a1: { x: 0, y: 0, ...CHAT_SIZE },
  a2: { x: 560, y: 0, ...CHAT_SIZE },
  b1: { x: 0, y: 0, ...CHAT_SIZE },
  loose: { x: 2000, y: 0, ...CHAT_SIZE }
}

export interface WorktreeCanvasesHarness extends AppHarness {
  agent: MockAgentApi
  /** Uninstalls the measured layout; call it from `afterEach`. */
  teardown(): void
}

export async function mountWorktreeCanvases(
  state: WorkspaceState = twoWorktrees(),
  apis: Record<string, Record<string, unknown>> = {}
): Promise<WorktreeCanvasesHarness> {
  const agent = createMockAgentApi()
  const harness = installWindowApis({
    state,
    apis: { agentApi: agent.api as unknown as Record<string, unknown>, ...apis }
  })
  // After the bridges, whose ResizeObserver stub it replaces; before the render it measures.
  const teardown = installMeasuredLayout(PANE)
  render(<App />)
  await screen.findByText('Add project')
  await waitFor(() => expect(nodeElement('loose')).not.toBeNull())
  return { ...harness, agent, teardown }
}

export function nodeElement(id: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"]`)
}

export function lastSaved(harness: AppHarness): WorkspaceState {
  const snapshot = harness.saved.at(-1)
  if (!snapshot) throw new Error('nothing was saved')
  return snapshot
}

export function savedNode(harness: AppHarness, id: string): WorkspaceTerminalNode {
  const node = lastSaved(harness).nodes.find((candidate) => candidate.id === id)
  if (!node) throw new Error(`${id} was not saved`)
  return node
}

export function geometry(node: { position: { x: number; y: number }; width: number; height: number }): unknown {
  return { x: node.position.x, y: node.position.y, width: node.width, height: node.height }
}

export function geometryOf(nodes: readonly WorkspaceTerminalNode[], id: string): unknown {
  const node = nodes.find((candidate) => candidate.id === id)
  return node ? geometry(node) : undefined
}

/** What React Flow renders for a node right now: its wrapper's inline size and its transform. */
export function shown(id: string): unknown {
  const element = nodeElement(id)!
  const [, x, y] = /translate\(\s*([-\d.]+)px,\s*([-\d.]+)px\)/.exec(element.style.transform) ?? []
  return {
    x: Number(x),
    y: Number(y),
    width: Number.parseFloat(element.style.width),
    height: Number.parseFloat(element.style.height)
  }
}

/** The main canvas's React Flow root, or a worktree's. */
export function flowRoot(canvas: string | null): HTMLElement {
  const root =
    canvas === null
      ? document.querySelector<HTMLElement>('.canvas-region > .react-flow')
      : nodeElement(`worktree:${canvas}`)?.querySelector<HTMLElement>('.worktree-canvas > .react-flow')
  if (!root) throw new Error(`no canvas ${canvas ?? 'main'}`)
  return root
}

/** A canvas's viewport as its transform reads: `translate(x, y) scale(zoom)`, whitespace dropped. */
export function viewportOf(canvas: string | null): string {
  return flowRoot(canvas).querySelector<HTMLElement>('.react-flow__viewport')!.style.transform.replace(/\s/g, '')
}

export const ORIGIN_VIEWPORT = 'translate(0px,0px)scale(1)'

/**
 * Announces that a worktree node was resized to everything observing inside it - React Flow's own
 * observer, which sizes the inner canvas, and the worktree canvas's, which re-fits its chats - in
 * the order a browser delivers them.
 */
export function worktreeResized(worktreeId: string): void {
  resizeObservedWithin(nodeElement(`worktree:${worktreeId}`)!)
}

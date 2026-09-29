import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, test } from 'vitest'
import { COLLAPSED_WORKTREE_HEIGHT } from '../src/renderer/src/canvas-workspace'
import {
  INSET,
  PANE,
  UNMOVED,
  WORKTREE_SIZE,
  geometry,
  lastSaved,
  mountWorktreeCanvases,
  nodeElement,
  shown,
  twoWorktrees,
  worktree,
  type WorktreeCanvasesHarness
} from './dom/worktree-canvases'

/**
 * Issue #25: collapsing a worktree leaves its header and its compact row and takes the canvas out
 * of view - and nothing else. Every chat on that canvas stays mounted, so an agent mid-turn, a
 * draft and a transcript scroll survive the collapse, the expand, and the layout moves in between.
 */

let harness: WorktreeCanvasesHarness

afterEach(() => harness?.teardown())

const COLLAPSED = { x: 0, y: 0, width: WORKTREE_SIZE.width, height: COLLAPSED_WORKTREE_HEIGHT }
const EXPANDED = { x: 0, y: 0, ...WORKTREE_SIZE }

function header(worktreeId: string): HTMLElement {
  return nodeElement(`worktree:${worktreeId}`)!.querySelector<HTMLElement>('.worktree-node-header')!
}

function collapse(worktreeId: string): void {
  fireEvent.click(within(header(worktreeId)).getByRole('button', { name: 'Collapse worktree' }))
}

function expand(worktreeId: string): void {
  fireEvent.click(within(header(worktreeId)).getByRole('button', { name: 'Expand worktree' }))
}

/** How many sessions the agent bridge was asked to create for `nodeId`. */
function createsFor(nodeId: string): number {
  const create = harness.agent.api.create as unknown as { mock: { calls: unknown[][] } }
  return create.mock.calls.filter(([request]) => (request as { id?: string }).id === nodeId).length
}

describe('collapsing a worktree', () => {
  test('keeps the header and bottom row, hides the canvas, and disturbs no chat on it', async () => {
    harness = await mountWorktreeCanvases()
    await waitFor(() => expect(createsFor('a1')).toBe(1))
    const composer = nodeElement('a1')!.querySelector('textarea')!
    fireEvent.change(composer, { target: { value: 'half-written prompt' } })
    // An agent mid-turn in the worktree.
    act(() => harness.agent.emit('a1', { type: 'status', status: 'working' }))
    await waitFor(() =>
      expect(screen.getByTitle(/^Focus Chat A1/)).toHaveAttribute('title', expect.stringMatching(/Working/))
    )

    collapse('w1')
    await waitFor(() => expect(shown('worktree:w1')).toEqual(COLLAPSED))
    const node = nodeElement('worktree:w1')!
    expect(node.querySelector('.worktree-node')).toHaveClass('collapsed')
    expect(node.querySelector('.worktree-node-header')).not.toBeNull()
    expect(node.querySelector('.worktree-actions')).not.toBeNull()
    expect(within(node).getByText('2 attached')).toBeInTheDocument()
    // The canvas is still there, with the chats on it - out of view, not gone.
    expect(node.querySelector('.worktree-canvas')).not.toBeNull()
    expect(nodeElement('a1')).not.toBeNull()
    expect(nodeElement('a1')!.querySelector('textarea')).toBe(composer)
    expect(composer.value).toBe('half-written prompt')
    expect(createsFor('a1')).toBe(1)
    expect(harness.agent.api.kill).not.toHaveBeenCalled()
    expect(screen.getByTitle(/^Focus Chat A1/)).toHaveAttribute('title', expect.stringMatching(/Working/))
    // No size to drag or fit while collapsed.
    expect(within(header('w1')).queryByRole('button', { name: 'Fit to canvas' })).toBeNull()
    expect(node.querySelector('.worktree-node > .node-resize-line')).toBeNull()
    expect(nodeElement('worktree:w2')!.querySelector('.worktree-node > .node-resize-line')).not.toBeNull()
    // Saved collapsed, at the height it expands back to.
    await waitFor(() => expect(lastSaved(harness).worktrees[0].collapsed).toBe(true))
    expect(geometry(lastSaved(harness).worktrees[0])).toEqual(EXPANDED)
    expect(geometry(lastSaved(harness).nodes[0])).toEqual(UNMOVED.a1)

    expand('w1')
    await waitFor(() => expect(shown('worktree:w1')).toEqual(EXPANDED))
    expect(nodeElement('a1')!.querySelector('textarea')).toBe(composer)
    expect(composer.value).toBe('half-written prompt')
    expect(shown('a1')).toEqual(UNMOVED.a1)
    expect(createsFor('a1')).toBe(1)
    await waitFor(() => expect(lastSaved(harness).worktrees[0].collapsed).toBeUndefined())
  })

  test('a workspace saved collapsed reopens collapsed at its chrome height, starts each chat once, and expands to the saved height', async () => {
    harness = await mountWorktreeCanvases(
      twoWorktrees({
        worktrees: [worktree('w1', 'feature/login', 0, { collapsed: true }), worktree('w2', 'feature/signup', 1000)]
      })
    )
    await waitFor(() => expect(shown('worktree:w1')).toEqual(COLLAPSED))
    expect(nodeElement('worktree:w1')!.querySelector('.worktree-node')).toHaveClass('collapsed')
    await waitFor(() => expect(createsFor('a1')).toBe(1))
    expect(createsFor('a2')).toBe(1)

    expand('w1')
    await waitFor(() => expect(shown('worktree:w1')).toEqual(EXPANDED))
    expect(shown('a1')).toEqual(UNMOVED.a1)
    expect(shown('a2')).toEqual(UNMOVED.a2)
    expect(createsFor('a1')).toBe(1)
  })

  test('tiling leaves a collapsed worktree where it is, and focusing one of its chats expands it', async () => {
    harness = await mountWorktreeCanvases()
    collapse('w1')
    await waitFor(() => expect(shown('worktree:w1')).toEqual(COLLAPSED))

    fireEvent.click(nodeElement('loose')!)
    fireEvent.keyDown(window, { key: 'a', code: 'KeyA', ctrlKey: true, shiftKey: true })
    // Two nodes take the grid: w2 and the loose chat, side by side.
    const cell = { width: (PANE.width - INSET * 2 - INSET) / 2, height: PANE.height - INSET * 2 }
    await waitFor(() => expect(shown('worktree:w2')).toEqual({ x: INSET, y: INSET, ...cell }))
    expect(shown('loose')).toEqual({ x: INSET + cell.width + INSET, y: INSET, ...cell })
    expect(shown('worktree:w1')).toEqual(COLLAPSED)

    fireEvent.click(screen.getByTitle(/^Focus Chat A1/))
    await waitFor(() => expect(shown('worktree:w1')).toEqual(EXPANDED))
    expect(nodeElement('a1')).toHaveClass('selected')
  })

  test('collapsing a focused worktree restores it first, so it expands back to its own size', async () => {
    harness = await mountWorktreeCanvases()
    fireEvent.click(within(header('w1')).getByRole('button', { name: 'Fit to canvas' }))
    await waitFor(() => expect((shown('worktree:w1') as { width: number }).width).toBe(PANE.width - INSET * 2))

    collapse('w1')
    await waitFor(() => expect(shown('worktree:w1')).toEqual(COLLAPSED))
    await waitFor(() => expect(geometry(lastSaved(harness).worktrees[0])).toEqual(EXPANDED))

    expand('w1')
    await waitFor(() => expect(shown('worktree:w1')).toEqual(EXPANDED))
    expect(within(header('w1')).getByRole('button', { name: 'Fit to canvas' })).toBeInTheDocument()
  })
})

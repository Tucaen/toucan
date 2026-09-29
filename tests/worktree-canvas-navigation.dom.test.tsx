import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, test } from 'vitest'
import {
  INSET,
  PANE,
  UNMOVED,
  WORKTREE_REGION,
  WORKTREE_SIZE,
  geometry,
  geometryOf,
  lastSaved,
  mountWorktreeCanvases,
  nodeElement,
  savedNode,
  shown,
  viewportOf,
  type WorktreeCanvasesHarness
} from './dom/worktree-canvases'

/**
 * Issue #25, through the real `App` with a measured layout: every layout command lands on the
 * canvas the selection is on. Two worktrees with chats and a chat on the main canvas are the
 * fixture, so a shortcut aimed at one worktree's chat has three wrong places it could go.
 */

let harness: WorktreeCanvasesHarness

afterEach(() => harness?.teardown())

function select(id: string): void {
  fireEvent.click(nodeElement(id)!)
}

async function saved(id: string, expected: unknown): Promise<void> {
  await waitFor(() => expect(geometry(savedNode(harness, id))).toEqual(expected))
}

describe('layout commands land on the canvas the selection is on', () => {
  test('Alt+Up on a chat selected inside a worktree fills that worktree and moves nothing elsewhere', async () => {
    harness = await mountWorktreeCanvases()
    select('a1')
    fireEvent.keyDown(window, { key: 'ArrowUp', code: 'ArrowUp', altKey: true })

    await waitFor(() => expect(shown('a1')).toEqual(WORKTREE_REGION))
    expect(shown('a2')).toEqual(UNMOVED.a2)
    expect(shown('b1')).toEqual(UNMOVED.b1)
    expect(shown('loose')).toEqual(UNMOVED.loose)
    expect(shown('worktree:w1')).toEqual({ x: 0, y: 0, ...WORKTREE_SIZE })
    expect(shown('worktree:w2')).toEqual({ x: 1000, y: 0, ...WORKTREE_SIZE })
    // The header offers Restore on that chat and nothing else.
    expect(within(nodeElement('a1')!).getByRole('button', { name: 'Restore' })).toBeInTheDocument()
    expect(within(nodeElement('a2')!).queryByRole('button', { name: 'Restore' })).toBeNull()
    // A maximised chat is a way of looking at it, not an arrangement: no snapshot carries it.
    for (const snapshot of harness.saved) expect(geometryOf(snapshot.nodes, 'a1')).toEqual(UNMOVED.a1)

    fireEvent.keyDown(window, { key: 'ArrowDown', code: 'ArrowDown', altKey: true })
    await waitFor(() => expect(shown('a1')).toEqual(UNMOVED.a1))
  })

  test('Alt+Left in a chat composer snaps that chat within its worktree; in a text input it does nothing', async () => {
    harness = await mountWorktreeCanvases()
    const composer = nodeElement('a2')!.querySelector('textarea')!
    fireEvent.keyDown(composer, { key: 'ArrowLeft', code: 'ArrowLeft', altKey: true })
    const half = { x: INSET, y: INSET, width: (WORKTREE_REGION.width - INSET) / 2, height: WORKTREE_REGION.height }
    await saved('a2', half)
    expect(geometry(savedNode(harness, 'a1'))).toEqual(UNMOVED.a1)

    const input = document.createElement('input')
    document.body.appendChild(input)
    fireEvent.keyDown(input, { key: 'ArrowRight', code: 'ArrowRight', altKey: true })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(geometry(savedNode(harness, 'a2'))).toEqual(half)
  })

  test('Ctrl+Shift+A tiles the worktree a chat is selected in, and the main canvas when nothing is', async () => {
    harness = await mountWorktreeCanvases()
    select('b1')
    // One chat in w2: it takes the whole region.
    fireEvent.keyDown(window, { key: 'a', code: 'KeyA', ctrlKey: true, shiftKey: true })
    await saved('b1', WORKTREE_REGION)
    expect(geometry(savedNode(harness, 'a1'))).toEqual(UNMOVED.a1)
    expect(geometry(savedNode(harness, 'a2'))).toEqual(UNMOVED.a2)
    expect(geometry(savedNode(harness, 'loose'))).toEqual(UNMOVED.loose)

    select('a1')
    fireEvent.keyDown(window, { key: 'a', code: 'KeyA', ctrlKey: true, shiftKey: true })
    const cell = (WORKTREE_REGION.width - INSET) / 2
    await saved('a1', { x: INSET, y: INSET, width: cell, height: WORKTREE_REGION.height })
    expect(geometry(savedNode(harness, 'a2'))).toEqual({
      x: INSET + cell + INSET,
      y: INSET,
      width: cell,
      height: WORKTREE_REGION.height
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
    expect(geometry(savedNode(harness, 'a1'))).toEqual({
      x: INSET,
      y: INSET,
      width: cell,
      height: WORKTREE_REGION.height
    })
    expect(geometry(savedNode(harness, 'b1'))).toEqual(WORKTREE_REGION)
  })

  test("a chat's header fit action fills its worktree and its restore returns it, while the snapshot keeps the durable geometry", async () => {
    harness = await mountWorktreeCanvases()
    fireEvent.click(within(nodeElement('a1')!).getByRole('button', { name: 'Fit to canvas' }))
    // The live chat fills the worktree canvas...
    await waitFor(() => expect(shown('a1')).toEqual(WORKTREE_REGION))
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
    harness = await mountWorktreeCanvases()
    fireEvent.click(screen.getByTitle(/^Focus Chat A2/))
    // Centred in the 900x624 canvas at zoom 1: (900-520)/2 - 560 = -370, (624-340)/2 = 142.
    await waitFor(() => expect(viewportOf('w1')).toBe('translate(-370px,142px)scale(1)'), { timeout: 2000 })
    // The main canvas centred the worktree that shows it: (1600-900)/2 = 350, (900-700)/2 = 100.
    expect(viewportOf(null)).toBe('translate(350px,100px)scale(1)')
  })
})

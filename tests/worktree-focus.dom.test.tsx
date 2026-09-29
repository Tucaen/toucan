import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, test } from 'vitest'
import { WORKTREE_CHROME_HEIGHT } from '../src/renderer/src/canvas-workspace'
import { NODE_FIT_INSET, canvasRegion } from '../src/renderer/src/node-snap'
import { resizeObserved } from './dom/measured-layout'
import {
  CHAT_SIZE,
  INSET,
  PANE,
  UNMOVED,
  WORKTREE_REGION,
  WORKTREE_SIZE,
  chat,
  flowRoot,
  geometry,
  lastSaved,
  mountWorktreeCanvases,
  nodeElement,
  shown,
  twoWorktrees,
  viewportOf,
  worktree,
  worktreeResized,
  worktreeHeader as header,
  type WorktreeCanvasesHarness
} from './dom/worktree-canvases'

/**
 * Issue #25: focus expands a worktree for use and restore puts it back - its place and size on the
 * main canvas, and the pan and zoom of its own canvas. Neither is an arrangement, so the snapshot
 * a focused worktree writes is the one it will return to.
 */

let harness: WorktreeCanvasesHarness

afterEach(() => harness?.teardown())

const LEFT_VIEWPORT = { x: -40, y: 10, zoom: 0.5 }
const LEFT_TRANSFORM = 'translate(-40px,10px)scale(0.5)'
const MAIN_REGION = { x: INSET, y: INSET, width: PANE.width - INSET * 2, height: PANE.height - INSET * 2 }
/** A focused worktree's canvas: the main region less the worktree's chrome. */
const FOCUSED_CANVAS = { width: MAIN_REGION.width, height: MAIN_REGION.height - WORKTREE_CHROME_HEIGHT }

function withLeftViewport(): ReturnType<typeof twoWorktrees> {
  return twoWorktrees({
    worktrees: [worktree('w1', 'feature/login', 0, { viewport: LEFT_VIEWPORT }), worktree('w2', 'feature/signup', 1000)]
  })
}

/** The pan and zoom a transform string reads. */
function parseViewport(transform: string): { x: number; y: number; zoom: number } {
  const [, x, y, zoom] = /translate\(([-\d.]+)px,([-\d.]+)px\)scale\(([\d.]+)\)/.exec(transform) ?? []
  return { x: Number(x), y: Number(y), zoom: Number(zoom) }
}

/** Whether every chat of w1, seen through the viewport, lies inside a canvas of `size`. */
function framesChats(transform: string, size: { width: number; height: number }): boolean {
  const { x, y, zoom } = parseViewport(transform)
  const chats = [UNMOVED.a1, UNMOVED.a2]
  return chats.every(
    (node) =>
      node.x * zoom + x >= -0.5 &&
      node.y * zoom + y >= -0.5 &&
      (node.x + node.width) * zoom + x <= size.width + 0.5 &&
      (node.y + node.height) * zoom + y <= size.height + 0.5
  )
}

/** Something durable has to change for a snapshot to be written; a chat on the main canvas snaps. */
async function forceSave(): Promise<void> {
  const before = harness.saved.length
  fireEvent.click(nodeElement('loose')!)
  fireEvent.keyDown(window, { key: 'ArrowLeft', code: 'ArrowLeft', altKey: true })
  await waitFor(() => expect(harness.saved.length).toBeGreaterThan(before))
}

describe('focusing a worktree', () => {
  test('the header action fills the main canvas and frames the chats; Restore returns both the frame and the inner viewport', async () => {
    harness = await mountWorktreeCanvases(withLeftViewport())
    expect(viewportOf('w1')).toBe(LEFT_TRANSFORM)

    fireEvent.click(within(header('w1')).getByRole('button', { name: 'Fit to canvas' }))
    await waitFor(() => expect(shown('worktree:w1')).toEqual(MAIN_REGION))
    worktreeResized('w1')
    await waitFor(() => expect(framesChats(viewportOf('w1'), FOCUSED_CANVAS)).toBe(true), { timeout: 2000 })
    expect(viewportOf('w1')).not.toBe(LEFT_TRANSFORM)
    // The other worktree and the main canvas's own viewport are untouched.
    expect(shown('worktree:w2')).toEqual({ x: 1000, y: 0, ...WORKTREE_SIZE })
    expect(viewportOf(null)).toBe('translate(0px,0px)scale(1)')

    // Focus is temporary in both dimensions: the snapshot keeps the geometry and the viewport
    // the worktree will return to.
    await forceSave()
    for (const snapshot of harness.saved) {
      expect(geometry(snapshot.worktrees[0])).toEqual({ x: 0, y: 0, ...WORKTREE_SIZE })
      expect(snapshot.worktrees[0].viewport).toEqual(LEFT_VIEWPORT)
    }

    fireEvent.click(within(header('w1')).getByRole('button', { name: 'Restore' }))
    await waitFor(() => expect(shown('worktree:w1')).toEqual({ x: 0, y: 0, ...WORKTREE_SIZE }))
    expect(viewportOf('w1')).toBe(LEFT_TRANSFORM)
    worktreeResized('w1')
    await forceSave()
    expect(lastSaved(harness).worktrees[0].viewport).toEqual(LEFT_VIEWPORT)
  })

  test('Alt+Up on a selected worktree focuses it and Alt+Down restores it, viewport included', async () => {
    harness = await mountWorktreeCanvases(withLeftViewport())
    fireEvent.click(header('w1'))
    fireEvent.keyDown(window, { key: 'ArrowUp', code: 'ArrowUp', altKey: true })
    await waitFor(() => expect(shown('worktree:w1')).toEqual(MAIN_REGION))
    worktreeResized('w1')
    await waitFor(() => expect(framesChats(viewportOf('w1'), FOCUSED_CANVAS)).toBe(true), { timeout: 2000 })

    fireEvent.keyDown(window, { key: 'ArrowDown', code: 'ArrowDown', altKey: true })
    await waitFor(() => expect(shown('worktree:w1')).toEqual({ x: 0, y: 0, ...WORKTREE_SIZE }))
    expect(viewportOf('w1')).toBe(LEFT_TRANSFORM)
  })

  test('a chat maximised inside a worktree follows the worktree canvas as focus and restore resize it', async () => {
    harness = await mountWorktreeCanvases(
      twoWorktrees({ nodes: [chat('a1', 'Chat A1', 'w1', 0), chat('loose', 'Loose chat', undefined, 2000)] })
    )
    fireEvent.click(within(nodeElement('a1')!).getByRole('button', { name: 'Fit to canvas' }))
    await waitFor(() => expect(shown('a1')).toEqual(WORKTREE_REGION))

    fireEvent.click(within(header('w1')).getByRole('button', { name: 'Fit to canvas' }))
    await waitFor(() => expect(shown('worktree:w1')).toEqual(MAIN_REGION))
    // The worktree's canvas grew with it; its observer says so, and the chat re-fits - measured
    // against the viewport before the focus frames it, which is where the chat will be returned to.
    worktreeResized('w1')
    await waitFor(() =>
      expect(shown('a1')).toEqual({
        x: INSET,
        y: INSET,
        width: FOCUSED_CANVAS.width - INSET * 2,
        height: FOCUSED_CANVAS.height - INSET * 2
      })
    )

    fireEvent.click(within(header('w1')).getByRole('button', { name: 'Restore' }))
    await waitFor(() => expect(shown('worktree:w1')).toEqual({ x: 0, y: 0, ...WORKTREE_SIZE }))
    worktreeResized('w1')
    await waitFor(() => expect(shown('a1')).toEqual(WORKTREE_REGION))
    // Still a way of looking at the chat: its snapshot is where it was before the maximise.
    await forceSave()
    expect(geometry(lastSaved(harness).nodes[0])).toEqual({ x: 0, y: 0, ...CHAT_SIZE })
    // The main canvas's React Flow never took part.
    expect(flowRoot(null).querySelector('.react-flow__viewport')!.getAttribute('style')).toContain('scale(1)')
  })

  test('focus, restore, a zoom and a tile never remount a chat, restart its agent or drop its draft', async () => {
    harness = await mountWorktreeCanvases()
    const create = harness.agent.api.create as unknown as { mock: { calls: unknown[][] } }
    await waitFor(() => expect(create.mock.calls.length).toBe(4))
    const composer = nodeElement('a1')!.querySelector('textarea')!
    fireEvent.change(composer, { target: { value: 'mid-thought' } })
    act(() => harness.agent.emit('a1', { type: 'status', status: 'working' }))
    await waitFor(() =>
      expect(screen.getByTitle(/^Focus Chat A1/)).toHaveAttribute('title', expect.stringMatching(/Working/))
    )

    fireEvent.click(within(header('w1')).getByRole('button', { name: 'Fit to canvas' }))
    await waitFor(() => expect(shown('worktree:w1')).toEqual(MAIN_REGION))
    worktreeResized('w1')
    fireEvent.wheel(nodeElement('a1')!, { deltaY: -100, ctrlKey: true, bubbles: true, cancelable: true })
    fireEvent.click(nodeElement('a2')!)
    fireEvent.keyDown(window, { key: 'a', code: 'KeyA', ctrlKey: true, shiftKey: true })
    await waitFor(() => expect((shown('a1') as { x: number }).x).not.toBe(0))
    fireEvent.click(within(header('w1')).getByRole('button', { name: 'Restore' }))
    await waitFor(() => expect(shown('worktree:w1')).toEqual({ x: 0, y: 0, ...WORKTREE_SIZE }))
    worktreeResized('w1')

    expect(nodeElement('a1')!.querySelector('textarea')).toBe(composer)
    expect(composer.value).toBe('mid-thought')
    expect(create.mock.calls.length).toBe(4)
    expect(harness.agent.api.kill).not.toHaveBeenCalled()
    expect(harness.agent.api.cancel).not.toHaveBeenCalled()
    expect(screen.getByTitle(/^Focus Chat A1/)).toHaveAttribute('title', expect.stringMatching(/Working/))
  })

  test('a focused worktree and the chat maximised inside it follow the window as it narrows', async () => {
    harness = await mountWorktreeCanvases(
      twoWorktrees({ nodes: [chat('a1', 'Chat A1', 'w1', 0), chat('loose', 'Loose chat', undefined, 2000)] })
    )
    fireEvent.click(within(nodeElement('a1')!).getByRole('button', { name: 'Fit to canvas' }))
    await waitFor(() => expect(shown('a1')).toEqual(WORKTREE_REGION))
    fireEvent.click(within(header('w1')).getByRole('button', { name: 'Fit to canvas' }))
    await waitFor(() => expect(shown('worktree:w1')).toEqual(MAIN_REGION))
    worktreeResized('w1')
    await waitFor(() => expect((shown('a1') as { width: number }).width).toBe(FOCUSED_CANVAS.width - INSET * 2))
    // Let the focus finish framing the chat, so the viewport below is the one the reflow reads.
    await new Promise((resolve) => setTimeout(resolve, 400))

    // The window narrows: the main region's observer reports it, and the worktree re-fits...
    const wide = { ...PANE }
    Object.assign(PANE, { width: 1100, height: 700 })
    try {
      resizeObserved(document.querySelector<HTMLElement>('.canvas-region')!)
      const narrow = { x: INSET, y: INSET, width: 1100 - INSET * 2, height: 700 - INSET * 2 }
      await waitFor(() => expect(shown('worktree:w1')).toEqual(narrow))
      // ...and its canvas's observer reports that, so the chat inside re-fits to what the
      // narrower canvas now shows, at the worktree canvas's own pan and zoom.
      worktreeResized('w1')
      const visible = canvasRegion(
        { width: narrow.width, height: narrow.height - WORKTREE_CHROME_HEIGHT },
        parseViewport(viewportOf('w1')),
        NODE_FIT_INSET
      )
      await waitFor(() =>
        expect(shown('a1')).toEqual({
          x: visible.position.x,
          y: visible.position.y,
          width: visible.width,
          height: visible.height
        })
      )
      // Restore still returns the durable geometry, which the resize never touched.
      fireEvent.click(within(header('w1')).getByRole('button', { name: 'Restore' }))
      await waitFor(() => expect(shown('worktree:w1')).toEqual({ x: 0, y: 0, ...WORKTREE_SIZE }))
    } finally {
      Object.assign(PANE, wide)
    }
  })
})

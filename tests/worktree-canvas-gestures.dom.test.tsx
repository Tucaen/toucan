import { fireEvent, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, test } from 'vitest'
import {
  ORIGIN_VIEWPORT,
  flowRoot,
  mountWorktreeCanvases,
  nodeElement,
  viewportOf,
  type WorktreeCanvasesHarness
} from './dom/worktree-canvases'

/**
 * Issue #25: a gesture moves the one canvas it was made on. Each worktree canvas is a React Flow
 * inside a node of the main one, so a wheel or a drag inside a worktree passes through two
 * canvases on its way up - and must be taken by exactly one. Plain wheel is neither's: it scrolls
 * the transcript under the pointer.
 */

let harness: WorktreeCanvasesHarness

afterEach(() => harness?.teardown())

/** One Ctrl+wheel notch up, as a mouse wheel or a trackpad pinch delivers it. */
function pinch(target: Element): boolean {
  return fireEvent.wheel(target, { deltaY: -100, ctrlKey: true, bubbles: true, cancelable: true })
}

/** The zoom `pinch` produces from 1: React Flow's wheel delta, 2^(100 * 0.002). */
const ONE_NOTCH = 2 ** 0.2

/**
 * A mouse event as d3-zoom follows it: it tracks the gesture on the event's `view`, which jsdom's
 * constructor refuses to set to the window the test sees, so it is set afterwards.
 */
function mouse(type: string, init: MouseEventInit): MouseEvent {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, ...init })
  Object.defineProperty(event, 'view', { value: window })
  return event
}

function zoomOf(canvas: string | null): number {
  return Number(/scale\(([^)]+)\)/.exec(viewportOf(canvas))?.[1])
}

describe('a gesture moves the canvas it was made on, and only that one', () => {
  test('Ctrl+wheel over a chat inside a worktree zooms that worktree canvas alone', async () => {
    harness = await mountWorktreeCanvases()
    const transcript = nodeElement('a1')!.querySelector('.chat-scroll') ?? nodeElement('a1')!
    // Consumed: the browser must not also zoom the page, and the main canvas must not see it.
    expect(pinch(transcript)).toBe(false)

    await waitFor(() => expect(zoomOf('w1')).toBeCloseTo(ONE_NOTCH, 5))
    expect(viewportOf(null)).toBe(ORIGIN_VIEWPORT)
    expect(viewportOf('w2')).toBe(ORIGIN_VIEWPORT)
    // Once, not twice: the zoom is exactly one notch.
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(zoomOf('w1')).toBeCloseTo(ONE_NOTCH, 5)
    // And the worktree remembers where its canvas was left.
    await waitFor(() => expect(harness.saved.at(-1)?.worktrees[0].viewport?.zoom).toBeCloseTo(ONE_NOTCH, 5))
    expect(harness.saved.at(-1)?.worktrees[1].viewport).toEqual({ x: 0, y: 0, zoom: 1 })
  })

  test('Ctrl+wheel over a chat on the main canvas zooms the main canvas alone', async () => {
    harness = await mountWorktreeCanvases()
    expect(pinch(nodeElement('loose')!)).toBe(false)

    await waitFor(() => expect(zoomOf(null)).toBeCloseTo(ONE_NOTCH, 5))
    expect(viewportOf('w1')).toBe(ORIGIN_VIEWPORT)
    expect(viewportOf('w2')).toBe(ORIGIN_VIEWPORT)
  })

  test("Ctrl+wheel over a worktree's header zooms the main canvas, since the header is the main canvas's", async () => {
    harness = await mountWorktreeCanvases()
    expect(pinch(nodeElement('worktree:w1')!.querySelector('.worktree-node-header')!)).toBe(false)

    await waitFor(() => expect(zoomOf(null)).toBeCloseTo(ONE_NOTCH, 5))
    expect(viewportOf('w1')).toBe(ORIGIN_VIEWPORT)
  })

  test('plain wheel over a chat is left to the transcript: no canvas moves and the scroll is not prevented', async () => {
    harness = await mountWorktreeCanvases()
    const inner = nodeElement('a1')!.querySelector('.chat-scroll') ?? nodeElement('a1')!
    expect(fireEvent.wheel(inner, { deltaY: 100, bubbles: true, cancelable: true })).toBe(true)
    expect(fireEvent.wheel(nodeElement('loose')!, { deltaY: 100, bubbles: true, cancelable: true })).toBe(true)

    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(viewportOf(null)).toBe(ORIGIN_VIEWPORT)
    expect(viewportOf('w1')).toBe(ORIGIN_VIEWPORT)
    expect(viewportOf('w2')).toBe(ORIGIN_VIEWPORT)
  })

  test("dragging a worktree's empty pane pans that canvas; the main canvas and the worktree stay put", async () => {
    harness = await mountWorktreeCanvases()
    const pane = flowRoot('w1').querySelector<HTMLElement>('.react-flow__pane')!
    pane.dispatchEvent(mouse('mousedown', { button: 0, buttons: 1, clientX: 300, clientY: 300 }))
    window.dispatchEvent(mouse('mousemove', { buttons: 1, clientX: 340, clientY: 320 }))
    window.dispatchEvent(mouse('mouseup', { button: 0, clientX: 340, clientY: 320 }))

    await waitFor(() => expect(viewportOf('w1')).toBe('translate(40px,20px)scale(1)'))
    expect(viewportOf(null)).toBe(ORIGIN_VIEWPORT)
    expect(viewportOf('w2')).toBe(ORIGIN_VIEWPORT)
    await waitFor(() => expect(harness.saved.at(-1)?.worktrees[0].viewport).toEqual({ x: 40, y: 20, zoom: 1 }))
    expect(harness.saved.at(-1)?.worktrees[0].position).toEqual({ x: 0, y: 0 })
  })

  test("dragging the main canvas's pane pans it alone", async () => {
    harness = await mountWorktreeCanvases()
    const pane = flowRoot(null).querySelector<HTMLElement>('.react-flow__pane')!
    pane.dispatchEvent(mouse('mousedown', { button: 0, buttons: 1, clientX: 300, clientY: 300 }))
    window.dispatchEvent(mouse('mousemove', { buttons: 1, clientX: 340, clientY: 320 }))
    window.dispatchEvent(mouse('mouseup', { button: 0, clientX: 340, clientY: 320 }))

    await waitFor(() => expect(viewportOf(null)).toBe('translate(40px,20px)scale(1)'))
    expect(viewportOf('w1')).toBe(ORIGIN_VIEWPORT)
    expect(viewportOf('w2')).toBe(ORIGIN_VIEWPORT)
  })
})

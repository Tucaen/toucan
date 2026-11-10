import { beforeEach, expect, test } from 'vitest'
import {
  READER_MARGIN,
  clampReaderRect,
  defaultReaderRect,
  forgetReaderRects,
  moveReaderRect,
  recallReaderRect,
  reflowReaderRect,
  rememberReaderRect,
  resizeReaderRect,
  snapReaderRect,
  toggleReaderFit
} from '../src/renderer/src/orchestration-reader-geometry'
import { NODE_FIT_INSET } from '../src/renderer/src/node-snap'

const viewport = { width: 1200, height: 800 }
/** The canvas region beside the sidebar and under the top bar: what a node's fullscreen fills. */
const canvas = { left: 240, top: 52, width: 960, height: 748 }

beforeEach(() => forgetReaderRects())

test('the default window sits at the right edge, inside the viewport', () => {
  const rect = defaultReaderRect(viewport)
  expect(rect.left + rect.width).toBeLessThanOrEqual(viewport.width - READER_MARGIN)
  expect(rect.top + rect.height).toBeLessThanOrEqual(viewport.height - READER_MARGIN)
  expect(rect.left).toBeGreaterThan(viewport.width / 2)
})

test('clamping keeps the window on screen but never limits its size', () => {
  expect(clampReaderRect({ left: -50, top: -20, width: 500, height: 400 }, viewport)).toEqual({
    left: READER_MARGIN,
    top: READER_MARGIN,
    width: 500,
    height: 400
  })
  const far = clampReaderRect({ left: 5000, top: 5000, width: 500, height: 400 }, viewport)
  expect(far.left).toBe(viewport.width - 500 - READER_MARGIN)
  expect(far.top).toBe(viewport.height - 400 - READER_MARGIN)
  expect(clampReaderRect({ left: 0, top: 0, width: 99999, height: 99999 }, viewport)).toMatchObject({
    width: 99999,
    height: 99999
  })
  expect(clampReaderRect({ left: 0, top: 0, width: 10, height: 10 }, viewport)).toMatchObject({ width: 10, height: 10 })
})

test('moving shifts the window and stops at the viewport edges', () => {
  const start = { left: 100, top: 100, width: 400, height: 300 }
  expect(moveReaderRect(start, 30, -20, viewport)).toEqual({ ...start, left: 130, top: 80 })
  expect(moveReaderRect(start, 9999, 9999, viewport)).toEqual({
    ...start,
    left: viewport.width - 400 - READER_MARGIN,
    top: viewport.height - 300 - READER_MARGIN
  })
})

test('resizing from the bottom-right corner keeps the top-left corner and has no size limit', () => {
  const start = { left: 100, top: 100, width: 400, height: 300 }
  expect(resizeReaderRect(start, 50, 40)).toEqual({ ...start, width: 450, height: 340 })
  expect(resizeReaderRect(start, 9999, 9999)).toEqual({ ...start, width: 10399, height: 10299 })
  expect(resizeReaderRect(start, -9999, -9999)).toMatchObject({ width: 1, height: 1 })
})

test('Alt+Arrow steps through the same slices as a node, inside the canvas region, and restores', () => {
  const start = { left: 100, top: 100, width: 400, height: 300 }
  const inset = NODE_FIT_INSET
  const left = snapReaderRect(start, null, 'left', canvas)
  expect(left.rect).toEqual({
    left: canvas.left + inset,
    top: canvas.top + inset,
    width: (canvas.width - 3 * inset) / 2,
    height: canvas.height - 2 * inset
  })
  const maximised = snapReaderRect(left.rect, left.snap, 'right', canvas)
  expect(maximised.rect).toEqual({
    left: canvas.left + inset,
    top: canvas.top + inset,
    width: canvas.width - 2 * inset,
    height: canvas.height - 2 * inset
  })
  const top = snapReaderRect(left.rect, left.snap, 'up', canvas)
  expect(top.rect.height).toBe((canvas.height - 3 * inset) / 2)
  const restored = snapReaderRect(top.rect, top.snap, 'down', canvas)
  expect(restored.snap).toMatchObject({ h: 'left', v: 'full' })
  const bottom = snapReaderRect(left.rect, left.snap, 'down', canvas)
  expect(bottom.snap).toMatchObject({ h: 'left', v: 'bottom' })
  expect(bottom.rect.top).toBe(canvas.top + inset + (canvas.height - 3 * inset) / 2 + inset)
  const home = snapReaderRect(bottom.rect, bottom.snap, 'down', canvas)
  expect(home).toEqual({ rect: start, snap: null })
})

test('the fit button fills exactly the node-fullscreen area: the canvas region less the fit inset', () => {
  const start = { left: 100, top: 100, width: 400, height: 300 }
  const fitted = toggleReaderFit(start, null, canvas)
  expect(fitted.rect).toEqual({
    left: canvas.left + NODE_FIT_INSET,
    top: canvas.top + NODE_FIT_INSET,
    width: canvas.width - 2 * NODE_FIT_INSET,
    height: canvas.height - 2 * NODE_FIT_INSET
  })
  expect(toggleReaderFit(fitted.rect, fitted.snap, canvas)).toEqual({ rect: start, snap: null })
})

test('a changed canvas region re-lays a snapped window and only keeps a free one on screen', () => {
  const start = { left: 100, top: 100, width: 400, height: 300 }
  const fitted = toggleReaderFit(start, null, canvas)
  // The sidebar collapsed: the canvas grew to the left.
  const wider = { ...canvas, left: 48, width: 1152 }
  expect(reflowReaderRect(fitted.rect, fitted.snap, wider, viewport)).toEqual({
    left: 64,
    top: 68,
    width: 1120,
    height: 716
  })
  expect(reflowReaderRect(start, null, wider, viewport)).toEqual(start)
  expect(reflowReaderRect({ ...start, left: 5000 }, null, wider, viewport).left).toBe(
    viewport.width - 400 - READER_MARGIN
  )
})

test('a remembered rectangle is returned per orchestrator node', () => {
  expect(recallReaderRect('a')).toBeUndefined()
  const rect = { left: 10, top: 20, width: 400, height: 300 }
  rememberReaderRect('a', rect)
  expect(recallReaderRect('a')).toEqual(rect)
  expect(recallReaderRect('b')).toBeUndefined()
})

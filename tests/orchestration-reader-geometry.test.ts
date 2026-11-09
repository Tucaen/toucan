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

test('Alt+Arrow steps through the same slices as a node and restores to where the window was', () => {
  const start = { left: 100, top: 100, width: 400, height: 300 }
  const inset = NODE_FIT_INSET
  const left = snapReaderRect(start, null, 'left', viewport)
  expect(left.rect).toEqual({
    left: inset,
    top: inset,
    width: (viewport.width - 3 * inset) / 2,
    height: viewport.height - 2 * inset
  })
  const maximised = snapReaderRect(left.rect, left.snap, 'right', viewport)
  expect(maximised.rect).toEqual({
    left: inset,
    top: inset,
    width: viewport.width - 2 * inset,
    height: viewport.height - 2 * inset
  })
  const top = snapReaderRect(left.rect, left.snap, 'up', viewport)
  expect(top.rect.height).toBe((viewport.height - 3 * inset) / 2)
  const restored = snapReaderRect(top.rect, top.snap, 'down', viewport)
  expect(restored.snap).toMatchObject({ h: 'left', v: 'full' })
  const bottom = snapReaderRect(left.rect, left.snap, 'down', viewport)
  expect(bottom.snap).toMatchObject({ h: 'left', v: 'bottom' })
  const home = snapReaderRect(bottom.rect, bottom.snap, 'down', viewport)
  expect(home).toEqual({ rect: start, snap: null })
})

test('the fit button maximises and the next press restores', () => {
  const start = { left: 100, top: 100, width: 400, height: 300 }
  const fitted = toggleReaderFit(start, null, viewport)
  expect(fitted.rect).toEqual({
    left: NODE_FIT_INSET,
    top: NODE_FIT_INSET,
    width: viewport.width - 32,
    height: viewport.height - 32
  })
  expect(toggleReaderFit(fitted.rect, fitted.snap, viewport)).toEqual({ rect: start, snap: null })
})

test('a changed viewport re-lays a snapped window and only keeps a free one on screen', () => {
  const start = { left: 100, top: 100, width: 400, height: 300 }
  const fitted = toggleReaderFit(start, null, viewport)
  const smaller = { width: 600, height: 500 }
  expect(reflowReaderRect(fitted.rect, fitted.snap, smaller)).toEqual({ left: 16, top: 16, width: 568, height: 468 })
  expect(reflowReaderRect(start, null, viewport)).toEqual(start)
})

test('a remembered rectangle is returned per orchestrator node', () => {
  expect(recallReaderRect('a')).toBeUndefined()
  const rect = { left: 10, top: 20, width: 400, height: 300 }
  rememberReaderRect('a', rect)
  expect(recallReaderRect('a')).toEqual(rect)
  expect(recallReaderRect('b')).toBeUndefined()
})

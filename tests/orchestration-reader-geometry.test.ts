import { beforeEach, expect, test } from 'vitest'
import {
  READER_MARGIN,
  READER_MAX,
  READER_MIN,
  clampReaderRect,
  defaultReaderRect,
  forgetReaderRects,
  moveReaderRect,
  recallReaderRect,
  rememberReaderRect,
  resizeReaderRect
} from '../src/renderer/src/orchestration-reader-geometry'

const viewport = { width: 1200, height: 800 }

beforeEach(() => forgetReaderRects())

test('the default window sits at the right edge, inside the viewport', () => {
  const rect = defaultReaderRect(viewport)
  expect(rect.left + rect.width).toBeLessThanOrEqual(viewport.width - READER_MARGIN)
  expect(rect.top + rect.height).toBeLessThanOrEqual(viewport.height - READER_MARGIN)
  expect(rect.left).toBeGreaterThan(viewport.width / 2)
})

test('clamping keeps the whole window on screen and its size between the limits', () => {
  expect(clampReaderRect({ left: -50, top: -20, width: 500, height: 400 }, viewport)).toEqual({
    left: READER_MARGIN,
    top: READER_MARGIN,
    width: 500,
    height: 400
  })
  const far = clampReaderRect({ left: 5000, top: 5000, width: 500, height: 400 }, viewport)
  expect(far.left).toBe(viewport.width - 500 - READER_MARGIN)
  expect(far.top).toBe(viewport.height - 400 - READER_MARGIN)
  const huge = clampReaderRect({ left: 0, top: 0, width: 99999, height: 99999 }, { width: 3000, height: 3000 })
  expect(huge.width).toBe(READER_MAX.width)
  expect(huge.height).toBe(READER_MAX.height)
  const tiny = clampReaderRect({ left: 0, top: 0, width: 10, height: 10 }, viewport)
  expect(tiny.width).toBe(READER_MIN.width)
  expect(tiny.height).toBe(READER_MIN.height)
})

test('a viewport smaller than the minimum size still holds the window', () => {
  const rect = clampReaderRect({ left: 0, top: 0, width: 500, height: 500 }, { width: 300, height: 240 })
  expect(rect.left).toBeGreaterThanOrEqual(0)
  expect(rect.left + rect.width).toBeLessThanOrEqual(300)
  expect(rect.top + rect.height).toBeLessThanOrEqual(240)
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

test('resizing from the bottom-right corner keeps the top-left corner and respects limits', () => {
  const start = { left: 100, top: 100, width: 400, height: 300 }
  expect(resizeReaderRect(start, 50, 40, viewport)).toEqual({ ...start, width: 450, height: 340 })
  expect(resizeReaderRect(start, -9999, -9999, viewport)).toEqual({
    ...start,
    width: READER_MIN.width,
    height: READER_MIN.height
  })
  const narrow = { width: 900, height: 800 }
  const grown = resizeReaderRect(start, 9999, 9999, narrow)
  expect(grown.left).toBe(100)
  expect(grown.top).toBe(100)
  expect(grown.left + grown.width).toBe(narrow.width - READER_MARGIN)
  expect(grown.top + grown.height).toBe(narrow.height - READER_MARGIN)
  expect(resizeReaderRect(start, 9999, 9999, { width: 3000, height: 3000 })).toMatchObject({
    width: READER_MAX.width,
    height: READER_MAX.height
  })
})

test('a remembered rectangle is returned per orchestrator node', () => {
  expect(recallReaderRect('a')).toBeUndefined()
  const rect = { left: 10, top: 20, width: 400, height: 300 }
  rememberReaderRect('a', rect)
  expect(recallReaderRect('a')).toEqual(rect)
  expect(recallReaderRect('b')).toBeUndefined()
})

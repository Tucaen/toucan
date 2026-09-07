import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  COMPOSER_MAX_HEIGHT,
  COMPOSER_MIN_HEIGHT,
  composerConsumesWheel,
  composerTextareaSize
} from '../src/renderer/src/composer-autosize'

test('a short prompt keeps the composer at its resting height', () => {
  assert.deepEqual(composerTextareaSize(20), { height: COMPOSER_MIN_HEIGHT, scrollable: false })
})

test('the box grows with the content between the two bounds', () => {
  const middle = (COMPOSER_MIN_HEIGHT + COMPOSER_MAX_HEIGHT) / 2
  assert.deepEqual(composerTextareaSize(middle), { height: middle, scrollable: false })
})

test('past the bound the box stops growing and scrolls instead', () => {
  assert.deepEqual(composerTextareaSize(COMPOSER_MAX_HEIGHT + 400), { height: COMPOSER_MAX_HEIGHT, scrollable: true })
})

test('the bound is low enough that the composer can never eat the transcript it is written against', () => {
  assert.ok(COMPOSER_MAX_HEIGHT > COMPOSER_MIN_HEIGHT)
  assert.ok(COMPOSER_MAX_HEIGHT < 320, 'a chat node is 340px tall at its smallest')
})

const grown = { scrollHeight: 400, clientHeight: COMPOSER_MAX_HEIGHT }

test('a grown composer keeps the gesture to itself in either direction', () => {
  assert.equal(composerConsumesWheel(grown), true)
})

test('a composer with nothing to scroll leaves the wheel to the canvas', () => {
  const resting = { scrollHeight: COMPOSER_MIN_HEIGHT, clientHeight: COMPOSER_MIN_HEIGHT }
  assert.equal(composerConsumesWheel(resting), false)
})

test('neither end of the travel hands the canvas a zoom mid-scroll', () => {
  // The scroll offset plays no part: only whether there is overflow at all.
  assert.equal(composerConsumesWheel({ ...grown, scrollHeight: grown.clientHeight + 200 }), true)
})

test('a box that only just fits after fractional layout is not scrollable', () => {
  assert.equal(composerConsumesWheel({ scrollHeight: 168.6, clientHeight: COMPOSER_MAX_HEIGHT }), false)
})

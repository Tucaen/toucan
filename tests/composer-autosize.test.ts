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

const grown = { scrollTop: 40, scrollHeight: 400, clientHeight: COMPOSER_MAX_HEIGHT }

test('a composer with room left in the wheel direction keeps the gesture to itself', () => {
  assert.equal(composerConsumesWheel(grown, 30), true)
  assert.equal(composerConsumesWheel(grown, -30), true)
})

test('a composer with nothing to scroll leaves the wheel to the canvas', () => {
  const resting = { scrollTop: 0, scrollHeight: COMPOSER_MIN_HEIGHT, clientHeight: COMPOSER_MIN_HEIGHT }
  assert.equal(composerConsumesWheel(resting, 30), false)
  assert.equal(composerConsumesWheel(resting, -30), false)
})

test('each end of the travel releases only the direction that has run out', () => {
  const top = { ...grown, scrollTop: 0 }
  assert.equal(composerConsumesWheel(top, -30), false)
  assert.equal(composerConsumesWheel(top, 30), true)
  const bottom = { ...grown, scrollTop: grown.scrollHeight - grown.clientHeight }
  assert.equal(composerConsumesWheel(bottom, 30), false)
  assert.equal(composerConsumesWheel(bottom, -30), true)
})

test('a fractional layout height still counts as the end of the travel', () => {
  const bottom = { scrollTop: 231.6, scrollHeight: 400, clientHeight: COMPOSER_MAX_HEIGHT }
  assert.equal(composerConsumesWheel(bottom, 30), false)
})

test('a wheel with no vertical component is not the composer to consume', () => {
  assert.equal(composerConsumesWheel(grown, 0), false)
})

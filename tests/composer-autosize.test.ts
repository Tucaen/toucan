import { strict as assert } from 'node:assert'
import { test } from 'vitest'
import { COMPOSER_MAX_HEIGHT, COMPOSER_MIN_HEIGHT, composerTextareaSize } from '../src/renderer/src/composer-autosize'

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

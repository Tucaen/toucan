import { strict as assert } from 'node:assert'
import { test } from 'vitest'
import { isNearScrollBottom, STICK_TO_BOTTOM_THRESHOLD_PX } from '../src/renderer/src/chat-scroll-follow'

test('scrolled exactly to the bottom counts as near the bottom', () => {
  assert.equal(isNearScrollBottom({ scrollTop: 400, scrollHeight: 600, clientHeight: 200 }), true)
})

test('scrolled up past the threshold does not count as near the bottom', () => {
  assert.equal(
    isNearScrollBottom({
      scrollTop: 600 - 200 - (STICK_TO_BOTTOM_THRESHOLD_PX + 1),
      scrollHeight: 600,
      clientHeight: 200
    }),
    false
  )
})

test('within the threshold of the bottom still counts as near the bottom', () => {
  assert.equal(
    isNearScrollBottom({
      scrollTop: 600 - 200 - STICK_TO_BOTTOM_THRESHOLD_PX,
      scrollHeight: 600,
      clientHeight: 200
    }),
    true
  )
})

test('content shorter than the viewport is always at the bottom', () => {
  assert.equal(isNearScrollBottom({ scrollTop: 0, scrollHeight: 100, clientHeight: 200 }), true)
})

test('a custom threshold overrides the default', () => {
  assert.equal(isNearScrollBottom({ scrollTop: 0, scrollHeight: 600, clientHeight: 200 }, 500), true)
  assert.equal(isNearScrollBottom({ scrollTop: 0, scrollHeight: 600, clientHeight: 200 }, 300), false)
})

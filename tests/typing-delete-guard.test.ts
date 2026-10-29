import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { createTypingDeleteGuard, TYPING_TAIL_MS } from '../src/renderer/src/typing-delete-guard'

// The pure half of #1; tests/chat-backspace-decision.dom.test.tsx drives it through the real App.

function guardAt(clock: { now: number }) {
  return createTypingDeleteGuard(() => clock.now)
}

describe('typing delete guard', () => {
  test('a delete key right after typing in a field, now off a non-field, is swallowed', () => {
    const clock = { now: 0 }
    const guard = guardAt(clock)
    assert.equal(guard.swallows({ key: 'Backspace', editable: true }), false)
    clock.now += 50
    assert.equal(guard.swallows({ key: 'Backspace', editable: false }), true)
    assert.equal(guard.swallows({ key: 'Delete', editable: false }), true)
  })

  test('a held key stays one gesture however long it repeats', () => {
    const clock = { now: 0 }
    const guard = guardAt(clock)
    guard.swallows({ key: 'a', editable: true })
    for (let repeat = 0; repeat < 10; repeat += 1) {
      clock.now += TYPING_TAIL_MS - 100
      assert.equal(guard.swallows({ key: 'Backspace', editable: false }), true)
    }
  })

  test('a press after a pause, or with no typing before it, passes through', () => {
    const clock = { now: 0 }
    const guard = guardAt(clock)
    assert.equal(guard.swallows({ key: 'Delete', editable: false }), false)
    guard.swallows({ key: 'a', editable: true })
    clock.now += TYPING_TAIL_MS + 1
    assert.equal(guard.swallows({ key: 'Delete', editable: false }), false)
  })

  test('another key or a pointer press ends the burst', () => {
    const clock = { now: 0 }
    const guard = guardAt(clock)
    guard.swallows({ key: 'a', editable: true })
    guard.swallows({ key: 'Escape', editable: false })
    assert.equal(guard.swallows({ key: 'Backspace', editable: false }), false)
    guard.swallows({ key: 'a', editable: true })
    guard.pointerPressed()
    assert.equal(guard.swallows({ key: 'Backspace', editable: false }), false)
  })

  test('keys typed inside a field are never swallowed', () => {
    const guard = guardAt({ now: 0 })
    assert.equal(guard.swallows({ key: 'Backspace', editable: true }), false)
  })
})

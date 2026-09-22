import { strict as assert } from 'node:assert'
import { test } from 'vitest'
import { composerSendKeys, isComposerSendKey, nodeFocusMode } from '../src/shared/workspace'

/**
 * The two pure rules the workspace snapshot is read through: what a saved node meant by hiding its
 * activity, and whether a persisted composer preference is one this build understands.
 */

test('focus mode reads the current field, then the legacy one, then defaults to off', () => {
  assert.equal(nodeFocusMode({ focusMode: true }), true)
  assert.equal(nodeFocusMode({ focusMode: false }), false)
  // A snapshot written before the field was renamed still means what it said.
  assert.equal(nodeFocusMode({ worklogCollapsed: true }), true)
  assert.equal(nodeFocusMode({}), false)
})

test('the current field wins over the legacy one, so a rewritten node cannot flip back', () => {
  // The store rewrites the field on load, but a recently-closed record is stored as it was and
  // comes back through the canvas carrying both - the newer answer has to be the one that counts.
  assert.equal(nodeFocusMode({ focusMode: false, worklogCollapsed: true }), false)
  assert.equal(nodeFocusMode({ focusMode: true, worklogCollapsed: false }), true)
})

test('only a send key this build knows survives being read back out of a snapshot', () => {
  for (const key of composerSendKeys) assert.equal(isComposerSendKey(key), true)
  assert.equal(isComposerSendKey('ctrl-enter'), false)
  assert.equal(isComposerSendKey(''), false)
  assert.equal(isComposerSendKey(undefined), false)
  assert.equal(isComposerSendKey(null), false)
  assert.equal(isComposerSendKey(0), false)
})

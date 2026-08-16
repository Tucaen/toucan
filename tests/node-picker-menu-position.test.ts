import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { computeNodePickerMenuPosition } from '../src/renderer/src/node-picker-menu-position'

test('opens below the trigger, right-aligned, when there is room', () => {
  const trigger = { top: 100, left: 440, right: 490, bottom: 120 }
  const position = computeNodePickerMenuPosition(trigger, { width: 230, height: 200 }, { width: 1200, height: 900 })

  assert.equal(position.top, 127)
  assert.equal(position.left, 490 - 230)
})

test('clamps the left edge instead of running off the left of a narrow panel', () => {
  // A trigger near the panel's left edge, e.g. the Provider picker in a resized-narrow FirstMate panel.
  const trigger = { top: 200, left: 10, right: 60, bottom: 220 }
  const position = computeNodePickerMenuPosition(trigger, { width: 230, height: 200 }, { width: 1200, height: 900 })

  assert.equal(position.left, 8, 'menu should be pulled onto screen rather than clipped past the left edge')
})

test('clamps the right edge instead of running off the right of the viewport', () => {
  const trigger = { top: 200, left: 1180, right: 1195, bottom: 220 }
  const position = computeNodePickerMenuPosition(trigger, { width: 230, height: 200 }, { width: 1200, height: 900 })

  assert.equal(position.left, 1200 - 230 - 8)
})

test('flips the menu above the trigger when it would clip the bottom of the viewport', () => {
  const trigger = { top: 850, left: 900, right: 1050, bottom: 870 }
  const position = computeNodePickerMenuPosition(trigger, { width: 230, height: 260 }, { width: 1200, height: 900 })

  assert.equal(position.top, 850 - 7 - 260)
})

test('clamps vertically when the menu is taller than the viewport in either direction', () => {
  const trigger = { top: 400, left: 900, right: 1050, bottom: 420 }
  const position = computeNodePickerMenuPosition(trigger, { width: 230, height: 5000 }, { width: 1200, height: 900 })

  assert.ok(position.top >= 8, 'menu must not clip above the viewport')
  assert.ok(position.top + 5000 >= 900 - 8 || position.top <= 8, 'menu should be pinned to a viewport-visible edge')
})

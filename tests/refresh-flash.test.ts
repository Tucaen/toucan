import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { confirmsRefresh } from '../src/renderer/src/use-refresh-flash'

/**
 * The rule behind the header chip's post-refresh cue. Account usage barely moves between two
 * clicks, so the cue is usually the only evidence a refresh did anything - which makes when it
 * fires worth pinning down on its own, without a DOM.
 */

test('a refresh that landed with a new reading is confirmed', () => {
  assert.equal(confirmsRefresh({ wasRefreshing: true, refreshing: false, stale: false }), true)
})

test('a refresh still in flight has nothing to confirm yet', () => {
  assert.equal(confirmsRefresh({ wasRefreshing: true, refreshing: true, stale: false }), false)
})

test('a refresh that fell back to the reading already on screen is not confirmed', () => {
  // The stale marking says the opposite; two contradicting signals are worse than one.
  assert.equal(confirmsRefresh({ wasRefreshing: true, refreshing: false, stale: true }), false)
})

test('the background poll does not confirm anything, since the user did not ask', () => {
  assert.equal(confirmsRefresh({ wasRefreshing: false, refreshing: false, stale: false }), false)
})

test('a second refresh starting is not itself a confirmation', () => {
  // The cue has to come down here so the refresh now starting has something to raise on landing.
  assert.equal(confirmsRefresh({ wasRefreshing: false, refreshing: true, stale: false }), false)
})

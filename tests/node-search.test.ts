import { deepEqual, equal } from 'node:assert/strict'
import { test } from 'node:test'
import {
  findMatchRanges,
  matchCountLabel,
  nodeSearchKeyAction,
  stepMatchIndex,
  type NodeSearchShortcutKey
} from '../src/renderer/src/node-search'

/*
 * In-node search (issue #170): the shortcut that opens it and the counting a find bar does.
 */

function key(overrides: Partial<NodeSearchShortcutKey> = {}): NodeSearchShortcutKey {
  return { key: 'f', ctrlKey: true, shiftKey: false, altKey: false, metaKey: false, ...overrides }
}

const canvas = { editingText: false, dialogOpen: false }

test('Ctrl+F opens search on the canvas and nowhere else', () => {
  equal(nodeSearchKeyAction(key(), canvas), 'open')
  equal(nodeSearchKeyAction(key({ key: 'F' }), canvas), 'open')
  equal(nodeSearchKeyAction(key({ ctrlKey: false }), canvas), 'none')
  equal(nodeSearchKeyAction(key({ shiftKey: true }), canvas), 'none')
  equal(nodeSearchKeyAction(key({ altKey: true }), canvas), 'none')
  equal(nodeSearchKeyAction(key({ metaKey: true }), canvas), 'none')
  equal(nodeSearchKeyAction(key({ key: 'g' }), canvas), 'none')
})

test('a text field and a dialog both stand the shortcut down', () => {
  equal(nodeSearchKeyAction(key(), { editingText: true, dialogOpen: false }), 'none')
  equal(nodeSearchKeyAction(key(), { editingText: false, dialogOpen: true }), 'none')
})

test('matches are literal, case-insensitive and non-overlapping', () => {
  deepEqual(findMatchRanges('Alpha alpha ALPHA', 'alpha'), [
    { start: 0, end: 5 },
    { start: 6, end: 11 },
    { start: 12, end: 17 }
  ])
  // Non-overlapping: the second 'aa' starts after the first match ends.
  deepEqual(findMatchRanges('aaaa', 'aa'), [
    { start: 0, end: 2 },
    { start: 2, end: 4 }
  ])
  // A literal query, never a pattern.
  deepEqual(findMatchRanges('a.c abc', '.'), [{ start: 1, end: 2 }])
  deepEqual(findMatchRanges('anything', ''), [])
  deepEqual(findMatchRanges('anything', 'zz'), [])
})

test('a text that does not lowercase one-for-one is searched case-sensitively rather than misaligned', () => {
  // 'İ' lowercases to two code units, which would slide every later offset off its match.
  const text = 'İstanbul and istanbul'
  for (const match of findMatchRanges(text, 'istanbul')) {
    equal(text.slice(match.start, match.end), 'istanbul')
  }
})

test('stepping wraps at both ends and reports nothing to step to', () => {
  equal(stepMatchIndex(3, 0, 1), 1)
  equal(stepMatchIndex(3, 2, 1), 0)
  equal(stepMatchIndex(3, 0, -1), 2)
  equal(stepMatchIndex(3, -1, 1), 0)
  equal(stepMatchIndex(3, -1, -1), 2)
  equal(stepMatchIndex(0, -1, 1), -1)
})

test('the count reads as a position, or says there is none', () => {
  equal(matchCountLabel(0, -1), 'No results')
  equal(matchCountLabel(12, 2), '3 of 12')
})

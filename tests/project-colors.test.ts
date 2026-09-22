import { strict as assert } from 'node:assert'
import { test } from 'vitest'
import {
  isProjectColor,
  normalizeProjectColor,
  paletteColorAt,
  PROJECT_COLOR_PALETTE
} from '../src/shared/project-colors'

/**
 * A project colour is stored in exactly one shape, because it is compared as a string wherever a
 * node, a chip and the sidebar have to agree they are showing the same project.
 */

test('a user-supplied colour is folded to lowercase #rrggbb, or refused outright', () => {
  assert.equal(normalizeProjectColor('#71A9FF'), '#71a9ff')
  assert.equal(normalizeProjectColor('  #71a9ff  '), '#71a9ff')
  assert.equal(normalizeProjectColor('#71a9ff'), '#71a9ff')

  // Every shape a colour input or a hand edit could produce that is not the stored one.
  assert.equal(normalizeProjectColor('#abc'), null)
  assert.equal(normalizeProjectColor('71a9ff'), null)
  assert.equal(normalizeProjectColor('#71a9ff80'), null)
  assert.equal(normalizeProjectColor('rebeccapurple'), null)
  assert.equal(normalizeProjectColor(''), null)
})

test('only the stored shape passes the guard, so a normalized colour always round-trips', () => {
  assert.equal(isProjectColor('#71a9ff'), true)
  assert.equal(isProjectColor('#71A9FF'), false)
  assert.equal(isProjectColor(0x71a9ff), false)
  assert.equal(isProjectColor(undefined), false)
  for (const colour of PROJECT_COLOR_PALETTE) assert.equal(normalizeProjectColor(colour), colour)
})

test('the palette answers for any integer index, wrapping rather than reading off the end', () => {
  const size = PROJECT_COLOR_PALETTE.length
  assert.equal(paletteColorAt(0), PROJECT_COLOR_PALETTE[0])
  assert.equal(paletteColorAt(size), PROJECT_COLOR_PALETTE[0])
  assert.equal(paletteColorAt(size + 1), PROJECT_COLOR_PALETTE[1])
  // A negative index is reachable from any caller that subtracts before it indexes.
  assert.equal(paletteColorAt(-1), PROJECT_COLOR_PALETTE[size - 1])
  assert.equal(paletteColorAt(-size), PROJECT_COLOR_PALETTE[0])
})

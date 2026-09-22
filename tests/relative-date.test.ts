import { strict as assert } from 'node:assert'
import { test } from 'vitest'
import { calendarDaysBetween, describeCalendarDate, formatRelativeTime } from '../src/renderer/src/relative-date'

// The one home for "when": an instant for transcripts, a calendar day for the board and library.

const NOW = Date.parse('2026-08-28T12:00:00.000Z')

test('an instant reads in the coarsest unit that still means something', () => {
  assert.equal(formatRelativeTime('2026-08-28T11:59:30.000Z', NOW), 'just now')
  assert.equal(formatRelativeTime('2026-08-28T11:30:00.000Z', NOW), '30m ago')
  assert.equal(formatRelativeTime('2026-08-28T09:00:00.000Z', NOW), '3h ago')
  assert.equal(formatRelativeTime('2026-08-25T12:00:00.000Z', NOW), '3d ago')
  assert.equal(formatRelativeTime('not a date', NOW), 'unknown')
})

test('past a month an instant reads as its own date rather than a widening count of days', () => {
  const at = '2026-06-01T12:00:00.000Z'
  assert.equal(formatRelativeTime(at, NOW), new Date(Date.parse(at)).toLocaleDateString())
})

test('a calendar date reads in days up to a week, then as itself', () => {
  assert.equal(describeCalendarDate('2026-08-31', '2026-08-31'), 'today')
  assert.equal(describeCalendarDate('2026-08-30', '2026-08-31'), 'yesterday')
  assert.equal(describeCalendarDate('2026-08-28', '2026-08-31'), '3 days ago')
  assert.equal(describeCalendarDate('2026-08-01', '2026-08-31'), '2026-08-01')
})

test('a value that is not a calendar date is returned in the words it was written in', () => {
  assert.equal(describeCalendarDate('not-a-date', '2026-08-31'), 'not-a-date')
  assert.equal(calendarDaysBetween('not-a-date', '2026-08-31'), null)
  assert.equal(calendarDaysBetween('2026-08-31', 'not-a-date'), null)
})

test('calendar days are counted at UTC midnight, so a local timezone cannot shift a boundary', () => {
  assert.equal(calendarDaysBetween('2026-08-30', '2026-08-31'), 1)
  assert.equal(calendarDaysBetween('2026-08-31', '2026-08-30'), -1)
  assert.equal(calendarDaysBetween('2026-01-01', '2026-12-31'), 364)
})

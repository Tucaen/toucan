import { describe, expect, test } from 'vitest'
import {
  cancelScheduledMessage,
  editScheduledMessage,
  isScheduledMessage,
  localDateTimeInputValue,
  markOverdueScheduledMessages,
  nextScheduledDelivery,
  nextDueScheduledMessage,
  parseLocalDateTimeInput,
  scheduleMessage,
  scheduleTimeProblem,
  takeScheduledMessage,
  type ScheduledMessage
} from '../src/shared/scheduled-message'

const now = new Date(2026, 8, 25, 12, 0).getTime()
const inAnHour = now + 60 * 60 * 1000
const image = { id: 'img-1', data: 'aGVsbG8=', mimeType: 'image/png' }

function entry(overrides: Partial<ScheduledMessage> = {}): ScheduledMessage {
  return { id: 'm1', text: 'ship it', images: [], deliverAt: inAnHour, ...overrides }
}

describe('scheduling a message', () => {
  test('captures text and attachments for a future time', () => {
    const result = scheduleMessage([], { id: 'm1', text: 'ship it', images: [image], deliverAt: inAnHour }, now)

    expect(result).toEqual({ ok: true, messages: [entry({ images: [image] })] })
  })

  test('refuses a time that is not in the future', () => {
    expect(scheduleMessage([], entry({ deliverAt: now }), now)).toEqual({ ok: false, problem: expect.any(String) })
    expect(scheduleMessage([], entry({ deliverAt: now - 1 }), now).ok).toBe(false)
    expect(scheduleTimeProblem(Number.NaN, now)).toMatch(/date and time/i)
    expect(scheduleTimeProblem(inAnHour, now)).toBeNull()
  })

  test('refuses a message with neither text nor attachments', () => {
    expect(scheduleMessage([], entry({ text: '   ' }), now).ok).toBe(false)
    expect(scheduleMessage([], entry({ text: '', images: [image] }), now).ok).toBe(true)
  })

  test('keeps the list in delivery order', () => {
    const later = entry({ id: 'later', deliverAt: inAnHour * 2 })
    const result = scheduleMessage([later], entry({ id: 'sooner' }), now)

    expect(result.ok && result.messages.map((message) => message.id)).toEqual(['sooner', 'later'])
  })
})

describe('editing and cancelling', () => {
  test('rewrites text and time, and a future time clears the overdue mark', () => {
    const overdue = entry({ deliverAt: now - 1000, overdue: true })
    const result = editScheduledMessage([overdue], 'm1', { text: 'revised', deliverAt: inAnHour }, now)

    expect(result).toEqual({ ok: true, messages: [entry({ text: 'revised' })] })
  })

  test('an overdue message may keep its passed time when only its text changes', () => {
    const overdue = entry({ deliverAt: now - 1000, overdue: true })
    const result = editScheduledMessage([overdue], 'm1', { text: 'revised', deliverAt: now - 1000 }, now)

    expect(result).toEqual({ ok: true, messages: [{ ...overdue, text: 'revised' }] })
  })

  test('refuses to move a message to a past time', () => {
    expect(editScheduledMessage([entry()], 'm1', { text: 'x', deliverAt: now - 1 }, now).ok).toBe(false)
  })

  test('refuses to empty a text-only message', () => {
    expect(editScheduledMessage([entry()], 'm1', { text: ' ', deliverAt: inAnHour }, now).ok).toBe(false)
  })

  test('cancelling removes only that message', () => {
    const other = entry({ id: 'm2' })
    expect(cancelScheduledMessage([entry(), other], 'm1')).toEqual([other])
  })
})

describe('delivery', () => {
  test('a message becomes due at its time, never while overdue', () => {
    const due = entry({ deliverAt: now })
    const overdue = entry({ id: 'm2', deliverAt: now - 5, overdue: true })

    expect(nextDueScheduledMessage([entry()], now)).toBeNull()
    expect(nextDueScheduledMessage([overdue, due], now)).toBe(due)
    expect(nextDueScheduledMessage([overdue], now)).toBeNull()
  })

  test('skips held messages', () => {
    const due = entry({ deliverAt: now })
    expect(nextDueScheduledMessage([due], now, new Set(['m1']))).toBeNull()
  })

  test('the next delivery time ignores overdue messages', () => {
    const overdue = entry({ id: 'm2', deliverAt: now - 5, overdue: true })
    expect(nextScheduledDelivery([overdue, entry()])).toBe(inAnHour)
    expect(nextScheduledDelivery([overdue])).toBeNull()
  })

  test('taking a message removes it and hands it back', () => {
    const other = entry({ id: 'm2' })
    expect(takeScheduledMessage([entry(), other], 'm1')).toEqual({ entry: entry(), rest: [other] })
    expect(takeScheduledMessage([other], 'm1')).toEqual({ entry: null, rest: [other] })
  })
})

describe('restoring after the application was closed', () => {
  test('marks every message whose time has passed as overdue and leaves the rest', () => {
    const passed = entry({ id: 'passed', deliverAt: now - 1 })
    const exact = entry({ id: 'exact', deliverAt: now })

    expect(markOverdueScheduledMessages([passed, exact, entry()], now)).toEqual([
      { ...passed, overdue: true },
      { ...exact, overdue: true },
      entry()
    ])
  })

  test('returns undefined for no messages so the node keeps its old shape', () => {
    expect(markOverdueScheduledMessages(undefined, now)).toBeUndefined()
    expect(markOverdueScheduledMessages([], now)).toBeUndefined()
  })
})

describe('validation of a persisted record', () => {
  test('accepts a complete record', () => {
    expect(isScheduledMessage(entry({ images: [image], overdue: true }))).toBe(true)
  })

  test.each([
    ['no id', { ...entry(), id: 1 }],
    ['no text', { ...entry(), text: undefined }],
    ['a bad time', { ...entry(), deliverAt: 'soon' }],
    ['an infinite time', { ...entry(), deliverAt: Number.POSITIVE_INFINITY }],
    ['a bad image', { ...entry(), images: [{ id: 'x' }] }],
    ['a bad overdue flag', { ...entry(), overdue: 'yes' }]
  ])('rejects %s', (_label, value) => {
    expect(isScheduledMessage(value)).toBe(false)
  })
})

describe('local date-time input', () => {
  test('round-trips a local time through the input value', () => {
    const value = localDateTimeInputValue(new Date(2026, 0, 5, 9, 7).getTime())

    expect(value).toBe('2026-01-05T09:07')
    expect(parseLocalDateTimeInput(value)).toBe(new Date(2026, 0, 5, 9, 7).getTime())
  })

  test('an empty or malformed value is not a time', () => {
    expect(parseLocalDateTimeInput('')).toBeNaN()
    expect(parseLocalDateTimeInput('tomorrow')).toBeNaN()
  })
})

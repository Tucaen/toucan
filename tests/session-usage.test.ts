import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  describeRateLimitWindow,
  describeRateLimitWindows,
  describeSessionUsage,
  formatResetsAt,
  formatTokens,
  mergeSessionUsage,
  usageLevel
} from '../src/renderer/src/session-usage'

// Issue #99: a chat node has to answer "how full is this conversation, what has it cost, and am I
// near an account limit" from data Toucan already collects. Every one of those decisions - the
// thresholds, the formatting, which window is the one about to bite - lives here so the bar itself
// is only markup.

test('token counts stay short enough for a one-line status bar', () => {
  assert.equal(formatTokens(0), '0')
  assert.equal(formatTokens(938), '938')
  assert.equal(formatTokens(1_000), '1.0k')
  assert.equal(formatTokens(48_231), '48.2k')
  // Past 100k a decimal buys nothing and costs a character in the tightest place in the UI.
  assert.equal(formatTokens(128_400), '128k')
  assert.equal(formatTokens(1_250_000), '1.3M')
})

test('the level thresholds match the account-usage chips in the header', () => {
  assert.equal(usageLevel(0), 'normal')
  assert.equal(usageLevel(74.9), 'normal')
  assert.equal(usageLevel(75), 'warning')
  assert.equal(usageLevel(89.9), 'warning')
  assert.equal(usageLevel(90), 'critical')
  assert.equal(usageLevel(140), 'critical')
})

test('a context gauge reports its fill, level and both a short and a long form', () => {
  const readout = describeSessionUsage({ usage: { used: 48_231, size: 200_000 } })
  assert.equal(readout.empty, false)
  assert.deepEqual(readout.context, {
    used: 48_231,
    size: 200_000,
    percent: 24,
    level: 'normal',
    label: '48.2k / 200k',
    title: 'Context: 48,231 of 200,000 tokens (24%)'
  })
  assert.equal(readout.cost, null)
  assert.equal(readout.limit, null)
})

test('a nearly full context window warns before the agent starts compacting', () => {
  const warning = describeSessionUsage({ usage: { used: 156_000, size: 200_000 } }).context
  assert.equal(warning?.level, 'warning')
  assert.match(String(warning?.warning), /compact/i)

  const critical = describeSessionUsage({ usage: { used: 188_000, size: 200_000 } }).context
  assert.equal(critical?.level, 'critical')
  assert.match(String(critical?.warning), /compact/i)
  assert.notEqual(critical?.warning, warning?.warning)
})

test('a context report with no window size, or a nonsensical one, is not rendered as a gauge', () => {
  assert.equal(describeSessionUsage({ usage: { used: 4_000 } }).context, null)
  assert.equal(describeSessionUsage({ usage: { used: 4_000, size: 0 } }).context, null)
  assert.equal(describeSessionUsage({ usage: { size: 200_000 } }).context, null)
})

test('a token count with no window behind it is still reported, just not as a fraction', () => {
  const readout = describeSessionUsage({ usage: { used: 48_231 } })
  assert.equal(readout.empty, false)
  assert.equal(readout.context, null)
  assert.equal(readout.tokens?.label, '48.2k tokens')
  assert.match(String(readout.tokens?.title), /48,231/)

  // A gauge already prints the count, so the standalone readout is the no-window case only.
  assert.equal(describeSessionUsage({ usage: { used: 48_231, size: 200_000 } }).tokens, null)
  assert.equal(describeSessionUsage({ usage: { size: 200_000 } }).tokens, null)
})

test('a context report over its own window clamps instead of overflowing the bar', () => {
  const context = describeSessionUsage({ usage: { used: 260_000, size: 200_000 } }).context
  assert.equal(context?.percent, 100)
  assert.equal(context?.level, 'critical')
})

test('cost is shown in the currency the provider reported', () => {
  assert.equal(describeSessionUsage({ usage: { cost: { amount: 0.4231, currency: 'USD' } } }).cost?.label, '$0.42')
  assert.equal(describeSessionUsage({ usage: { cost: { amount: 12.5, currency: 'USD' } } }).cost?.label, '$12.50')
  assert.equal(describeSessionUsage({ usage: { cost: { amount: 0.4231, currency: 'EUR' } } }).cost?.label, '0.42 EUR')
})

test('a cost too small to round to a cent says so rather than reading as free', () => {
  assert.equal(describeSessionUsage({ usage: { cost: { amount: 0.0004, currency: 'USD' } } }).cost?.label, '<$0.01')
  // An genuinely zero-cost session (a free tier, an unmetered turn) is exactly free.
  assert.equal(describeSessionUsage({ usage: { cost: { amount: 0, currency: 'USD' } } }).cost?.label, '$0.00')
})

test('the surfaced account window is the one that will bite first', () => {
  const readout = describeSessionUsage({
    rateLimits: {
      fiveHour: { usedPercent: 12 },
      weekly: { usedPercent: 83, resetsAt: 3_600_000 }
    },
    now: 0
  })
  assert.equal(readout.limit?.label, '7d')
  assert.equal(readout.limit?.displayPercent, 83)
  assert.equal(readout.limit?.level, 'warning')
  // Both windows still reach the tooltip - the bar only has room to show one.
  assert.match(String(readout.limit?.title), /5h: 12%/)
  assert.match(String(readout.limit?.title), /7d: 83% \(resets in 1h \| \d\d:\d\d\)/)
})

test('a per-model allowance competes for the bar under its own name and reaches the tooltip', () => {
  const readout = describeSessionUsage({
    rateLimits: {
      fiveHour: { usedPercent: 42 },
      weekly: { usedPercent: 24 },
      models: [{ label: 'Fable', usedPercent: 91, resetsAt: 3_600_000 }]
    },
    now: 0
  })
  assert.equal(readout.limit?.label, 'Fable')
  assert.equal(readout.limit?.displayPercent, 91)
  assert.equal(readout.limit?.level, 'critical')
  assert.match(String(readout.limit?.title), /5h: 42%/)
  assert.match(String(readout.limit?.title), /7d: 24%/)
  assert.match(String(readout.limit?.title), /Fable: 91% \(resets in 1h \| \d\d:\d\d\)/)
})

test('a provider that has actually refused a request reads as critical whatever its percentages say', () => {
  const readout = describeSessionUsage({ rateLimits: { fiveHour: { usedPercent: 41 }, rejected: true } })
  assert.equal(readout.limit?.level, 'critical')
  assert.equal(readout.limit?.rejected, true)
  assert.match(String(readout.limit?.title), /limit reached/i)
})

test('no usage and no limits is nothing worth taking a row of the node for', () => {
  const readout = describeSessionUsage({})
  assert.equal(readout.empty, true)
  assert.deepEqual(readout, { context: null, tokens: null, cost: null, limit: null, empty: true })
  assert.equal(describeSessionUsage({ usage: {}, rateLimits: null }).empty, true)
})

test('a later report keeps what it does not mention rather than blanking the bar', () => {
  const first = mergeSessionUsage(null, { used: 40_000, size: 200_000, cost: { amount: 1.5, currency: 'USD' } })
  assert.deepEqual(first, { used: 40_000, size: 200_000, cost: { amount: 1.5, currency: 'USD' } })

  // Claude reports a cost only once a turn has produced tokens, and Codex reports none at all, so
  // a cost-free update must not erase a cost the session has already been told about.
  const second = mergeSessionUsage(first, { used: 52_000, size: 200_000 })
  assert.deepEqual(second, { used: 52_000, size: 200_000, cost: { amount: 1.5, currency: 'USD' } })

  // A real new value still wins, including a window that changed because the model did.
  const third = mergeSessionUsage(second, { used: 60_000, size: 1_000_000, cost: { amount: 2.25, currency: 'USD' } })
  assert.deepEqual(third, { used: 60_000, size: 1_000_000, cost: { amount: 2.25, currency: 'USD' } })

  // An update that reports nothing at all leaves the previous reading exactly as it was.
  assert.deepEqual(mergeSessionUsage(third, {}), third)
})

test('reset times are relative, coarse, never negative, and name the clock time they land on', () => {
  assert.equal(formatResetsAt(0, 1_000), 'now')

  // Built from local components rather than epoch offsets: the clock half of the readout is local,
  // so a fixed string would only pass in the timezone it was written in.
  const resetsAt = new Date(2026, 8, 1, 13, 37).getTime()
  assert.equal(formatResetsAt(resetsAt, resetsAt - 60_000), '1m | 13:37')
  assert.equal(formatResetsAt(resetsAt, resetsAt - 90 * 60_000), '1h 30m | 13:37')
  assert.equal(formatResetsAt(resetsAt, resetsAt - 120 * 60_000), '2h | 13:37')
})

test('reset times longer than a day use days and include the local reset date', () => {
  const resetsAt = new Date(2026, 8, 1, 13, 37).getTime()
  const now = resetsAt - ((3 * 24 + 10) * 60 + 4) * 60_000

  assert.equal(formatResetsAt(resetsAt, now), '3d 10h 4m | 01.09. - 13:37')
})

test('one window describes itself the same way wherever it is rendered', () => {
  assert.deepEqual(describeRateLimitWindow('5h', { usedPercent: 96.4, resetsAt: 60_000 }, 0), {
    label: '5h',
    percent: 96.4,
    displayPercent: 96,
    level: 'critical',
    text: `5h: 96% (resets in 1m | ${formatResetsAt(60_000, 0).split(' | ')[1]})`
  })
  assert.deepEqual(describeRateLimitWindow('7d', { usedPercent: 5 }, 0), {
    label: '7d',
    percent: 5,
    displayPercent: 5,
    level: 'normal',
    text: '7d: 5%'
  })
})

test('the reset marker walks the bar from window start to reset', () => {
  const fiveHours = 5 * 60 * 60_000
  // One hour into a 5h window: 20% elapsed, so the marker sits a fifth of the way along.
  const oneHourIn = describeRateLimitWindow('5h', { usedPercent: 10, resetsAt: 4 * 60 * 60_000 }, 0, fiveHours)
  assert.equal(oneHourIn.resetProgressPercent, 20)
  // A reset that has already passed reads as the right edge, never past it.
  const overdue = describeRateLimitWindow('5h', { usedPercent: 10, resetsAt: -60_000 }, 0, fiveHours)
  assert.equal(overdue.resetProgressPercent, 100)
  // A reset further out than the window's own span clamps to the start rather than going negative.
  const beyond = describeRateLimitWindow('5h', { usedPercent: 10, resetsAt: 6 * 60 * 60_000 }, 0, fiveHours)
  assert.equal(beyond.resetProgressPercent, 0)
})

test('no reset moment or unknown window span means no marker', () => {
  const fiveHours = 5 * 60 * 60_000
  assert.equal(describeRateLimitWindow('5h', { usedPercent: 10 }, 0, fiveHours).resetProgressPercent, undefined)
  // A window whose producer did not state its span gets no marker; guessing one would misreport it.
  assert.equal(
    describeRateLimitWindow('Fable', { usedPercent: 10, resetsAt: 60_000 }, 0).resetProgressPercent,
    undefined
  )
})

test('a per-model window carries its own span, so it gets a marker like the plan windows', () => {
  const sevenDays = 7 * 24 * 60 * 60_000
  const windows = describeRateLimitWindows(
    { models: [{ label: 'Fable', usedPercent: 40, resetsAt: sevenDays / 2, windowMinutes: 7 * 24 * 60 }] },
    0
  )
  assert.equal(windows.length, 1)
  assert.equal(windows[0].label, 'Fable')
  assert.equal(windows[0].resetProgressPercent, 50)
})

test('a window a provider reports past its own limit is shown as full, not as 120%', () => {
  // Display maths belongs here rather than in the three places a window is rendered.
  const over = describeRateLimitWindow('5h', { usedPercent: 120 }, 0)
  assert.equal(over.displayPercent, 100)
  assert.equal(over.text, '5h: 100%')
  assert.equal(over.level, 'critical')
  assert.equal(describeRateLimitWindow('7d', { usedPercent: -4 }, 0).displayPercent, 0)
})

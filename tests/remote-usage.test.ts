import { strict as assert } from 'node:assert'
import { test } from 'vitest'
import { parseProviderUsageReport, PROVIDER_USAGE_POLL_MS } from '../src/shared/remote-usage'

/**
 * The `/api/usage` body, read the way the phone has to read it: this is a number the reader plans
 * their evening around, so a field that is not there is better than a field that is guessed at.
 */

const FULL = {
  claude: {
    status: {
      fiveHour: { usedPercent: 42, resetsAt: 1_700_000_000_000 },
      weekly: { usedPercent: 88 },
      models: [{ label: 'Fable', usedPercent: 12, windowMinutes: 10_080 }],
      rejected: false
    },
    readAt: 1_699_999_000_000,
    stale: false
  }
}

test('a well-formed report survives the round trip verbatim', () => {
  assert.deepEqual(parseProviderUsageReport(JSON.parse(JSON.stringify(FULL))), FULL)
})

test('an empty report is an ordinary answer, not a failure', () => {
  assert.deepEqual(parseProviderUsageReport({}), {})
})

test('anything that is not an object at all is refused outright', () => {
  for (const value of [null, undefined, 7, 'claude', [], true]) {
    assert.equal(parseProviderUsageReport(value), null, `${JSON.stringify(value)} should not parse`)
  }
})

test('a provider Toucan does not know is dropped rather than carried into the UI', () => {
  assert.deepEqual(parseProviderUsageReport({ ...FULL, gemini: FULL.claude }), FULL)
})

test('one damaged provider does not take the readable one with it', () => {
  const report = parseProviderUsageReport({ ...FULL, codex: { status: 'nope', readAt: 1, stale: false } })
  assert.deepEqual(report, FULL)
})

test('an entry without a reading time is dropped, because the phone dates every figure it shows', () => {
  assert.deepEqual(parseProviderUsageReport({ claude: { status: { weekly: { usedPercent: 10 } }, stale: false } }), {})
  assert.deepEqual(
    parseProviderUsageReport({ claude: { status: { weekly: { usedPercent: 10 } }, readAt: 'soon', stale: false } }),
    {}
  )
})

test('staleness is never inferred: an entry that does not state it is dropped', () => {
  assert.deepEqual(parseProviderUsageReport({ claude: { status: {}, readAt: 1 } }), {})
})

test('a window whose percentage is not a finite number is dropped, not clamped', () => {
  const report = parseProviderUsageReport({
    claude: { status: { fiveHour: { usedPercent: 'lots' }, weekly: { usedPercent: 50 } }, readAt: 1, stale: false }
  })
  assert.deepEqual(report, { claude: { status: { weekly: { usedPercent: 50 } }, readAt: 1, stale: false } })
})

test('a reset moment that is not a number is dropped while the percentage it came with survives', () => {
  const report = parseProviderUsageReport({
    claude: { status: { weekly: { usedPercent: 50, resetsAt: 'tomorrow' } }, readAt: 1, stale: false }
  })
  assert.deepEqual(report, { claude: { status: { weekly: { usedPercent: 50 } }, readAt: 1, stale: false } })
})

test('a per-model window without a label has nothing to render under and is dropped', () => {
  const report = parseProviderUsageReport({
    claude: { status: { models: [{ usedPercent: 9 }, { label: 'Fable', usedPercent: 12 }] }, readAt: 1, stale: false }
  })
  assert.deepEqual(report, {
    claude: { status: { models: [{ label: 'Fable', usedPercent: 12 }] }, readAt: 1, stale: false }
  })
})

test('a status that reports no window at all is still an entry, since `rejected` alone is news', () => {
  const report = parseProviderUsageReport({ claude: { status: { rejected: true }, readAt: 1, stale: true } })
  assert.deepEqual(report, { claude: { status: { rejected: true }, readAt: 1, stale: true } })
})

test('the phone polls no harder than the desktop, which is what the host caches for', () => {
  assert.equal(PROVIDER_USAGE_POLL_MS, 60_000)
})

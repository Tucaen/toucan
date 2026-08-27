import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { parseCodexRateLimits } from '../src/main/codex-rate-limits'

function tokenCount(rateLimits: unknown): string {
  return JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', rate_limits: rateLimits } })
}

test('reads the weekly window from a Codex plan that meters only one', () => {
  const status = parseCodexRateLimits([
    tokenCount({
      limit_id: 'codex',
      primary: { used_percent: 64, window_minutes: 10080, resets_at: 1788169581 },
      secondary: null
    })
  ])

  assert.deepEqual(status, { weekly: { usedPercent: 64, resetsAt: 1788169581000 } })
})

test('buckets a short window as five-hour and a long one as weekly', () => {
  const status = parseCodexRateLimits([
    tokenCount({
      primary: { used_percent: 12.5, window_minutes: 300, resets_at: 1788000000 },
      secondary: { used_percent: 80, window_minutes: 10080, resets_at: 1788169581 }
    })
  ])

  assert.deepEqual(status, {
    fiveHour: { usedPercent: 12.5, resetsAt: 1788000000000 },
    weekly: { usedPercent: 80, resetsAt: 1788169581000 }
  })
})

test('the newest report wins over earlier ones', () => {
  const status = parseCodexRateLimits([
    tokenCount({ primary: { used_percent: 10, window_minutes: 10080 } }),
    tokenCount({ primary: { used_percent: 42, window_minutes: 10080 } })
  ])

  assert.deepEqual(status, { weekly: { usedPercent: 42 } })
})

test('a reached limit is reported as rejected', () => {
  const status = parseCodexRateLimits([
    tokenCount({
      primary: { used_percent: 100, window_minutes: 10080 },
      rate_limit_reached_type: 'primary'
    })
  ])

  assert.equal(status?.rejected, true)
})

test('records without usable rate limits are skipped in favour of older ones that have them', () => {
  const status = parseCodexRateLimits([
    tokenCount({ primary: { used_percent: 33, window_minutes: 10080 } }),
    tokenCount(null),
    JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message' } }),
    'not json at all'
  ])

  assert.deepEqual(status, { weekly: { usedPercent: 33 } })
})

test('a transcript with no rate limits at all reports nothing rather than a zeroed window', () => {
  assert.equal(parseCodexRateLimits([tokenCount(null), 'partial line {']), null)
})

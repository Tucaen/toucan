import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { claudeRateLimitsFromUsage, createClaudeUsageReader } from '../src/main/claude-usage'

test('maps both plan windows, converting the ISO reset into epoch milliseconds', () => {
  const status = claudeRateLimitsFromUsage({
    rate_limits_available: true,
    rate_limits: {
      five_hour: { utilization: 53, resets_at: '2026-08-27T10:59:59.854372+00:00' },
      seven_day: { utilization: 27, resets_at: '2026-09-01T02:59:59.854392+00:00' }
    }
  })

  assert.deepEqual(status, {
    fiveHour: { usedPercent: 53, resetsAt: Date.parse('2026-08-27T10:59:59.854372+00:00') },
    weekly: { usedPercent: 27, resetsAt: Date.parse('2026-09-01T02:59:59.854392+00:00') }
  })
})

test('keeps a window that reports usage without a reset time', () => {
  const status = claudeRateLimitsFromUsage({
    rate_limits_available: true,
    rate_limits: { five_hour: { utilization: 12, resets_at: null }, seven_day: null }
  })

  assert.deepEqual(status, { fiveHour: { usedPercent: 12 } })
})

test('reports nothing when plan limits do not apply to the session', () => {
  const status = claudeRateLimitsFromUsage({
    rate_limits_available: false,
    rate_limits: null
  })

  assert.equal(status, null)
})

test('reports nothing rather than a zeroed window when no window is present', () => {
  assert.equal(claudeRateLimitsFromUsage({ rate_limits_available: true, rate_limits: {} }), null)
  assert.equal(claudeRateLimitsFromUsage(null), null)
})

test('an unusable reset time leaves the window without one instead of NaN', () => {
  const status = claudeRateLimitsFromUsage({
    rate_limits_available: true,
    rate_limits: { five_hour: { utilization: 5, resets_at: 'not a date' } }
  })

  assert.deepEqual(status, { fiveHour: { usedPercent: 5 } })
})

test('a failing usage request leaves the header blank instead of propagating', async () => {
  const reader = createClaudeUsageReader({
    cwd: 'C:\\anywhere',
    requestUsage: () => Promise.reject(new Error('claude is not installed'))
  })

  assert.equal(await reader.read(), null)
})

test('reads through the injected request without spawning a CLI', async () => {
  const seen: string[] = []
  const reader = createClaudeUsageReader({
    cwd: 'C:\\projects\\ade',
    requestUsage: (cwd) => {
      seen.push(cwd)
      return Promise.resolve({
        rate_limits_available: true,
        rate_limits: { seven_day: { utilization: 80, resets_at: null } }
      })
    }
  })

  assert.deepEqual(await reader.read(), { weekly: { usedPercent: 80 } })
  assert.deepEqual(seen, ['C:\\projects\\ade'])
})

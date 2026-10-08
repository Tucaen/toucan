import { strict as assert } from 'node:assert'
import { test } from 'vitest'
import {
  DEFAULT_ORCHESTRATION_PACING_POLICY,
  decideOrchestrationPacing,
  type OrchestrationPacingInput
} from '../src/shared/orchestration-pacing'

const NOW = Date.parse('2026-10-08T12:00:00.000Z')

function input(overrides: Partial<OrchestrationPacingInput> = {}): OrchestrationPacingInput {
  return {
    action: 'spawn',
    usage: { status: { fiveHour: { usedPercent: 0 } }, readAt: NOW, stale: false },
    freshness: 'fresh',
    now: NOW,
    activeTicketSessions: 0,
    ...overrides
  }
}

test('the five-hour curve is deterministic at its thresholds and preserves an idle provider reserve', () => {
  assert.deepEqual(
    decideOrchestrationPacing(
      input({ usage: { status: { fiveHour: { usedPercent: 69.9 } }, readAt: NOW, stale: false } })
    ),
    {
      action: 'spawn',
      state: 'unrestricted',
      reason: 'five_hour_below_drain_threshold',
      constrainingWindow: 'five_hour',
      freshness: 'fresh',
      activeTicketSessions: 0
    }
  )
  assert.deepEqual(
    decideOrchestrationPacing(
      input({ usage: { status: { fiveHour: { usedPercent: 70 } }, readAt: NOW, stale: false } })
    ),
    {
      action: 'spawn',
      state: 'unrestricted',
      reason: 'five_hour_below_drain_threshold',
      constrainingWindow: 'five_hour',
      freshness: 'fresh',
      activeTicketSessions: 0
    }
  )
  assert.deepEqual(
    decideOrchestrationPacing(
      input({
        usage: { status: { fiveHour: { usedPercent: 70 } }, readAt: NOW, stale: false },
        activeTicketSessions: 1
      })
    ),
    {
      action: 'spawn',
      state: 'drain',
      reason: 'five_hour_drain_active_ticket_work',
      constrainingWindow: 'five_hour',
      freshness: 'fresh',
      activeTicketSessions: 1
    }
  )
  assert.deepEqual(
    decideOrchestrationPacing(
      input({ usage: { status: { fiveHour: { usedPercent: 85, resetsAt: NOW + 60_000 } }, readAt: NOW, stale: false } })
    ),
    {
      action: 'spawn',
      state: 'pause',
      reason: 'five_hour_pause_threshold',
      constrainingWindow: 'five_hour',
      freshness: 'fresh',
      activeTicketSessions: 0,
      resetsAt: NOW + 60_000
    }
  )
})

test('an elapsed reset does not release a fresh reading that remains above the pause threshold', () => {
  assert.deepEqual(
    decideOrchestrationPacing(
      input({ usage: { status: { fiveHour: { usedPercent: 100, resetsAt: NOW } }, readAt: NOW - 1, stale: false } })
    ),
    {
      action: 'spawn',
      state: 'pause',
      reason: 'five_hour_pause_threshold',
      constrainingWindow: 'five_hour',
      freshness: 'fresh',
      activeTicketSessions: 0,
      resetsAt: NOW
    }
  )
})

test('stale or unavailable usage retains only the configured one-ticket reserve', () => {
  for (const freshness of ['stale', 'unavailable'] as const) {
    assert.deepEqual(
      decideOrchestrationPacing(
        input({ freshness, usage: freshness === 'stale' ? { status: {}, readAt: NOW - 1, stale: true } : null })
      ),
      {
        action: 'spawn',
        state: 'unrestricted',
        reason: freshness === 'stale' ? 'stale_usage_reserve_available' : 'unavailable_usage_reserve_available',
        constrainingWindow: 'usage_freshness',
        freshness,
        activeTicketSessions: 0
      }
    )
    assert.deepEqual(
      decideOrchestrationPacing(
        input({
          freshness,
          usage: freshness === 'stale' ? { status: {}, readAt: NOW - 1, stale: true } : null,
          activeTicketSessions: 1
        })
      ),
      {
        action: 'spawn',
        state: 'drain',
        reason: freshness === 'stale' ? 'stale_usage_reserve_exhausted' : 'unavailable_usage_reserve_exhausted',
        constrainingWindow: 'usage_freshness',
        freshness,
        activeTicketSessions: 1
      }
    )
  }
})

test('weekly and model-scoped windows do not receive an aggressive pacing curve', () => {
  assert.deepEqual(
    decideOrchestrationPacing(
      input({
        usage: {
          status: { weekly: { usedPercent: 100 }, models: [{ label: 'Fable', usedPercent: 100 }] },
          readAt: NOW,
          stale: false
        },
        activeTicketSessions: 4
      })
    ),
    {
      action: 'spawn',
      state: 'unrestricted',
      reason: 'no_five_hour_window',
      constrainingWindow: 'none',
      freshness: 'fresh',
      activeTicketSessions: 4
    }
  )
})

test('the policy seam can reserve a different number of tickets without changing the decision shape', () => {
  const policy = {
    ...DEFAULT_ORCHESTRATION_PACING_POLICY,
    unavailableUsage: { maxActiveTicketSessions: 2 }
  }
  assert.equal(
    decideOrchestrationPacing(input({ freshness: 'unavailable', usage: null, activeTicketSessions: 1 }), policy).state,
    'unrestricted'
  )
  assert.equal(
    decideOrchestrationPacing(input({ freshness: 'unavailable', usage: null, activeTicketSessions: 2 }), policy).state,
    'drain'
  )
})

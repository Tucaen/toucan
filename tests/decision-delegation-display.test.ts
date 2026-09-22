import { strict as assert } from 'node:assert'
import { test } from 'vitest'
import {
  DECISION_DELEGATION_OFF_OPTION,
  DECISION_DELEGATION_ON_OPTION,
  describeDecisionDelegation
} from '../src/renderer/src/decision-delegation-display'
import { DECISION_DELEGATION_CLAUDE_ONLY_MESSAGE } from '../src/shared/decision-delegation'

// Issue #213: the picker's note is the honesty layer, exactly as it is for routine delegation -
// the workspace preference is a request, the session's launch-time policy is the truth, and the
// note speaks only when the two disagree.

const configured = { status: 'configured' as const }

test('the boundary is explained on the On option itself', () => {
  const display = describeDecisionDelegation({ enabled: false }, null, true)
  assert.equal(display.selectedId, DECISION_DELEGATION_OFF_OPTION.id)
  const on = display.options.find((option) => option.id === DECISION_DELEGATION_ON_OPTION.id)
  assert.match(on?.description ?? '', /choose, score, route, classify/i)
  assert.match(on?.description ?? '', /produces or edits files stays where it is/i)
  assert.equal(on?.disabled, undefined)
  assert.equal(display.note, undefined)
})

test('a missing skill disables the On option and says how to get it, without closing the picker', () => {
  const display = describeDecisionDelegation({ enabled: false }, null, false)
  const on = display.options.find((option) => option.id === DECISION_DELEGATION_ON_OPTION.id)
  assert.equal(on?.disabled, true)
  assert.match(on?.description ?? '', /install `typesafe@typesafe-ai`/i)
  // Off stays selectable, and both options are still offered: the trigger is what re-probes.
  assert.equal(display.options.length, 2)
  assert.equal(display.options[0].disabled, undefined)
})

test('an unprobed availability leaves the option open rather than guessing it away', () => {
  const display = describeDecisionDelegation({ enabled: true }, configured, undefined)
  assert.equal(display.options.find((option) => option.id === 'on')?.disabled, undefined)
  assert.equal(display.note, undefined)
})

test('a preference the session has not launched under yet says when it applies', () => {
  assert.match(describeDecisionDelegation({ enabled: true }, null, true).note ?? '', /next starts or resumes/)
  assert.match(
    describeDecisionDelegation({ enabled: false }, configured, true).note ?? '',
    /until this conversation restarts/
  )
})

test('a withheld configuration surfaces its own reason, Codex included', () => {
  const claude = describeDecisionDelegation(
    { enabled: true },
    { status: 'unavailable', message: 'The typesafe@typesafe-ai skill is not installed.' },
    false
  )
  assert.match(claude.note ?? '', /is not installed/)
  const codex = describeDecisionDelegation(
    { enabled: true },
    { status: 'unavailable', message: DECISION_DELEGATION_CLAUDE_ONLY_MESSAGE },
    true
  )
  assert.match(codex.note ?? '', /Claude sessions for now/)
})

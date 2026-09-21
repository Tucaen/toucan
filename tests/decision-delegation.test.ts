import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  DECISION_PROVIDER_PLUGIN_ID,
  DECISION_PROVIDER_SKILL_NAME,
  appliedDecisionDelegation,
  decisionDelegationInstruction,
  decisionDelegationRequest,
  isDecisionDelegationPreference
} from '../src/shared/decision-delegation'

// Issue #213: an opt-in session instruction telling the main model it may hand decision-shaped
// subtasks (choose, score, route, classify) to an installed decision-provider skill. Claude only
// in v1, withheld rather than carried when the skill is absent, and worded as requested rather
// than enforced throughout.

test('the preference validator accepts what the workspace may store and nothing looser', () => {
  assert.equal(isDecisionDelegationPreference({ enabled: true }), true)
  assert.equal(isDecisionDelegationPreference({ enabled: false }), true)
  assert.equal(isDecisionDelegationPreference({ enabled: 'yes' }), false)
  assert.equal(isDecisionDelegationPreference({}), false)
  assert.equal(isDecisionDelegationPreference(null), false)
  assert.equal(isDecisionDelegationPreference([]), false)
})

test('an off preference carries nothing, so an off session launches exactly as it did before', () => {
  assert.equal(decisionDelegationRequest({ enabled: false }), undefined)
  assert.equal(decisionDelegationRequest({ enabled: true }), true)
})

test('the policy is configured only for a Claude session that has the skill', () => {
  assert.deepEqual(appliedDecisionDelegation('claude', true), { status: 'configured' })
})

test('Codex is withheld with the follow-up named, not silently dropped', () => {
  const applied = appliedDecisionDelegation('codex', true)
  assert.equal(applied.status, 'unavailable')
  assert.match(applied.message ?? '', /Claude sessions for now/)
})

test('a missing or unprobed skill withholds the instruction rather than pointing at nothing', () => {
  for (const installed of [false, undefined]) {
    const applied = appliedDecisionDelegation('claude', installed)
    assert.equal(applied.status, 'unavailable')
    assert.ok(applied.message?.includes(DECISION_PROVIDER_PLUGIN_ID))
  }
})

test('the instruction names the skill and authorizes it for decision-shaped subtasks', () => {
  const instruction = decisionDelegationInstruction()
  assert.match(instruction, new RegExp(DECISION_PROVIDER_SKILL_NAME))
  for (const shape of ['choosing between options', 'scoring candidates', 'routing an intent', 'classifying']) {
    assert.match(instruction, new RegExp(shape))
  }
})

test('the instruction states its precedence over routine delegation explicitly', () => {
  const instruction = decisionDelegationInstruction()
  assert.match(instruction, /prefer the decision provider over spawning a routine worker/i)
  // The boundary itself, so a session carrying both policies knows which is which.
  assert.match(instruction, /produces or edits files/i)
  assert.match(instruction, /verdicts/i)
  // Classification stays in the main model's reasoning: no separate classifier call.
  assert.match(instruction, /no separate classifier call/i)
})

test('the instruction carries the restraint clause, because every call is assumed billable', () => {
  const instruction = decisionDelegationInstruction()
  assert.match(instruction, /not on a single trivial choice/i)
  assert.match(instruction, /billable/i)
})

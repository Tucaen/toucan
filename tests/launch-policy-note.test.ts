import { strict as assert } from 'node:assert'
import { test } from 'vitest'
import { launchPolicyNote, type LaunchedDelegation } from '../src/shared/launch-policy-note'

// The one honesty line every delegation picker shows: silent while the selection and the running
// session agree, and specific about which of the two the user is actually getting when they do not.

const off: LaunchedDelegation = { status: 'off' }
const matching: LaunchedDelegation = { status: 'delegating', matchesSelection: true }
const different: LaunchedDelegation = { status: 'delegating', matchesSelection: false }

test('agreement says nothing at all', () => {
  assert.equal(launchPolicyNote(true, matching), undefined)
  assert.equal(launchPolicyNote(false, off), undefined)
})

test('a selection the session has not launched with reads as pending', () => {
  const pending = 'Applies when this conversation next starts or resumes'
  assert.equal(launchPolicyNote(true, off), pending)
  assert.equal(launchPolicyNote(true, different), pending, 'a different worker is not the selected one')
})

test('switching off does not stop the session that already launched delegating', () => {
  assert.equal(launchPolicyNote(false, matching), 'Still delegating until this conversation restarts')
  assert.equal(
    launchPolicyNote(false, matching, 'decisions'),
    'Still delegating decisions until this conversation restarts'
  )
})

test('a session that could not apply the policy says why, whichever way the preference points', () => {
  const unavailable: LaunchedDelegation = { status: 'unavailable', message: 'The worker model is not installed.' }
  assert.equal(launchPolicyNote(true, unavailable), 'The worker model is not installed.')
  assert.equal(launchPolicyNote(false, unavailable, 'decisions'), 'The worker model is not installed.')
})

test('an unavailable policy with no reason to give stays silent rather than inventing one', () => {
  assert.equal(launchPolicyNote(true, { status: 'unavailable', message: undefined }), undefined)
})

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { promptFailure } from '../src/main/acp-session-manager'

test('turns prompt-level ACP authentication failures into an actionable sign-in state', () => {
  const methods = [{ id: 'claude-ai-login', name: 'Claude Subscription', type: 'terminal' as const }]
  const failure = promptFailure({ code: -32000, message: 'Authentication required' }, methods)

  assert.deepEqual(failure.events, [
    { type: 'auth', methods },
    { type: 'status', status: 'auth_required', message: 'Authentication required' }
  ])
  assert.deepEqual(failure.result, { ok: false, message: 'Authentication required' })
})

test('turns a Claude OAuth-refresh failure into the same actionable sign-in state, despite its non-standard error code', () => {
  // Reproduced by driving the claude-agent-acp adapter directly with an invalid/expired
  // .credentials.json: an OAuth session that fails to refresh mid-turn surfaces as a generic
  // -32603 "Internal error: Failed to authenticate: OAuth session expired and could not be
  // refreshed" whose data.errorKind is the SDK's own "authentication_failed" marker - not the
  // ACP protocol's -32000 authRequired code isAuthRequired otherwise checks for.
  const methods = [{ id: 'claude-ai-login', name: 'Claude Subscription', type: 'terminal' as const }]
  const failure = promptFailure(
    {
      code: -32603,
      message: 'Internal error: Failed to authenticate: OAuth session expired and could not be refreshed',
      data: { errorKind: 'authentication_failed' }
    },
    methods
  )

  assert.deepEqual(failure.events, [
    { type: 'auth', methods },
    {
      type: 'status',
      status: 'auth_required',
      message: 'Internal error: Failed to authenticate: OAuth session expired and could not be refreshed'
    }
  ])
  assert.equal(failure.result.ok, false)
})

test('does not treat an unrelated internal error carrying a different errorKind as auth-required', () => {
  const failure = promptFailure(
    { code: -32603, message: 'Internal error: rate limited', data: { errorKind: 'rate_limit' } },
    []
  )

  assert.deepEqual(failure.events, [
    { type: 'error', message: 'Internal error: rate limited' },
    { type: 'status', status: 'idle' }
  ])
})

test('keeps ordinary prompt failures visible and returns the conversation to idle', () => {
  const failure = promptFailure(new Error('Provider unavailable'), [])

  assert.deepEqual(failure.events, [
    { type: 'error', message: 'Provider unavailable' },
    { type: 'status', status: 'idle' }
  ])
  assert.deepEqual(failure.result, { ok: false, message: 'Provider unavailable' })
})

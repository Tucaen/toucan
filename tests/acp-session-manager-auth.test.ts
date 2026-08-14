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

test('keeps ordinary prompt failures visible and returns the conversation to idle', () => {
  const failure = promptFailure(new Error('Provider unavailable'), [])

  assert.deepEqual(failure.events, [
    { type: 'error', message: 'Provider unavailable' },
    { type: 'status', status: 'idle' }
  ])
  assert.deepEqual(failure.result, { ok: false, message: 'Provider unavailable' })
})

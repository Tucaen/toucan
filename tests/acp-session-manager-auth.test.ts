import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { Writable } from 'node:stream'
import type { AgentPromptResult } from '../src/shared/agent'
import { createPromptWakeGate } from '../src/main/prompt-wake-gate'
import { extractLoginUrl, promptFailure, promptGuard, writeAuthCode } from '../src/main/acp-session-manager'

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

test('promptGuard passes prompts through while the session is not parked in auth_required', () => {
  assert.equal(promptGuard({ authRequired: false }), null)
})

test('promptGuard blocks a prompt once the session is parked in auth_required', () => {
  const guard = promptGuard({ authRequired: true })
  assert.notEqual(guard, null)
  assert.equal(guard?.ok, false)
})

test(
  'a wake-gate queue built up while the agent was working does not retry once auth_required is hit — '
  + 'only the first queued message re-triggers the (broken) prompt, the rest short-circuit immediately',
  async () => {
    // Reproduces the "repeatedly shows the error text" symptom: without the authRequired guard,
    // every queued message drained a wake-gate flush would re-attempt delivery against the same
    // expired credential, re-sending a fresh auth/auth_required event pair each time (and
    // flashing `status: working` in between) instead of the sign-in affordance settling once.
    const running = { authRequired: false }
    let deliveryAttempts = 0
    const deliver = async (_text: string): Promise<AgentPromptResult> => {
      const guard = promptGuard(running)
      if (guard) return guard
      deliveryAttempts += 1
      running.authRequired = true
      return { ok: false, message: 'OAuth session expired and could not be refreshed' }
    }
    const gate = createPromptWakeGate({ deliver })
    const first = gate.enqueue('queued while working 1')
    const second = gate.enqueue('queued while working 2')
    const third = gate.enqueue('queued while working 3')

    gate.flush()

    const results = await Promise.all([first, second, third])
    assert.equal(deliveryAttempts, 1, 'only the first queued message should reach the broken prompt call')
    for (const result of results) assert.equal(result.ok, false)
    gate.dispose()
  }
)

test('extractLoginUrl finds the OAuth URL in a terminal-auth CLI\'s "click here" line', () => {
  const line = 'To authorize, open your browser. If the link does not open automatically, '
    + 'click here: https://claude.ai/oauth/authorize?client_id=abc&state=xyz'
  assert.equal(
    extractLoginUrl(line),
    'https://claude.ai/oauth/authorize?client_id=abc&state=xyz'
  )
})

test('extractLoginUrl returns undefined for plain status text with no URL', () => {
  assert.equal(extractLoginUrl('Waiting for you to complete authentication in the browser...'), undefined)
})

test('writes the browser paste-back code to the live terminal-auth stdin', async () => {
  let written = ''
  const input = new Writable({
    write(chunk, _encoding, callback) {
      written += chunk.toString()
      callback()
    }
  })

  const result = await writeAuthCode(input, '  oauth-code-from-browser  ')

  assert.deepEqual(result, { ok: true })
  assert.equal(written, 'oauth-code-from-browser\n')
})

test('refuses a paste-back code when no terminal-auth process is waiting', async () => {
  assert.deepEqual(await writeAuthCode(undefined, 'oauth-code-from-browser'), {
    ok: false,
    message: 'No sign-in process is waiting for a code.'
  })
})

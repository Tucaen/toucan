import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { DELEGATION_OFF_OPTION, describeRoutineDelegation } from '../src/renderer/src/routine-delegation-display'

// Issues #178/#179: the picker's note is the honesty layer - the workspace preference is a request,
// the session's launch-time policy is the truth, and a configured worker is never claimed as
// enforced. Both providers speak this one contract.

const configured = { workerModelId: 'gpt-5.6-luna', workerEffortId: 'low', status: 'configured' as const }
const claudeConfigured = { workerModelId: 'haiku', status: 'configured' as const }

test('the boundary is explained on the worker option itself', () => {
  const display = describeRoutineDelegation('codex', { enabled: false }, null)
  assert.equal(display.selectedId, DELEGATION_OFF_OPTION.id)
  const worker = display.options.find((option) => option.id === 'gpt-5.6-luna')
  assert.match(worker?.description ?? '', /planning, diagnosis and review stay on the main model/i)
  assert.match(worker?.description ?? '', /low reasoning/)
  assert.equal(display.note, undefined)
})

test('a Claude node offers the Claude workers only, and each provider reads its own choice', () => {
  const preference = { enabled: true, codexWorkerModelId: 'gpt-5.6-luna', claudeWorkerModelId: 'haiku' }
  const claude = describeRoutineDelegation('claude', preference, claudeConfigured)
  assert.deepEqual(
    claude.options.map((option) => option.id),
    [DELEGATION_OFF_OPTION.id, 'haiku']
  )
  assert.equal(claude.selectedId, 'haiku')
  // Haiku has no effort level, so the option does not pretend to one.
  assert.doesNotMatch(claude.options[1]?.description ?? '', /reasoning\)/)
  assert.match(claude.note ?? '', /not provider-confirmed/)
  const codex = describeRoutineDelegation('codex', preference, configured)
  assert.equal(codex.selectedId, 'gpt-5.6-luna')
})

test('a session launched under the current preference reads as requested, never enforced', () => {
  const display = describeRoutineDelegation('codex', { enabled: true, codexWorkerModelId: 'gpt-5.6-luna' }, configured)
  assert.equal(display.selectedId, 'gpt-5.6-luna')
  assert.match(display.note ?? '', /not provider-confirmed/)
})

test('a preference the session has not launched under yet says when it applies', () => {
  // Enabled after launch: the policy is fixed at creation/resume, so it waits for the next safe
  // creation or resume rather than cancelling the running session.
  assert.match(describeRoutineDelegation('codex', { enabled: true }, null).note ?? '', /next starts or resumes/)
  assert.match(describeRoutineDelegation('claude', { enabled: true }, null).note ?? '', /next starts or resumes/)
  // Disabled after launch: the running session still carries its launch-time policy.
  assert.match(
    describeRoutineDelegation('claude', { enabled: false }, claudeConfigured).note ?? '',
    /until this conversation restarts/
  )
})

test('a withheld configuration surfaces its own reason', () => {
  const display = describeRoutineDelegation(
    'codex',
    { enabled: true },
    { ...configured, status: 'unavailable', message: 'This Codex account does not list gpt-5.6-luna.' }
  )
  assert.match(display.note ?? '', /does not list gpt-5\.6-luna/)
  const claude = describeRoutineDelegation(
    'claude',
    { enabled: true },
    { ...claudeConfigured, status: 'unavailable', message: 'This Claude session does not list haiku.' }
  )
  assert.match(claude.note ?? '', /does not list haiku/)
})

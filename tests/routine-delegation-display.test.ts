import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { DELEGATION_OFF_OPTION, describeRoutineDelegation } from '../src/renderer/src/routine-delegation-display'

// Issue #178: the picker's note is the honesty layer - the workspace preference is a request, the
// session's launch-time policy is the truth, and a configured worker is never claimed as enforced.

const configured = { workerModelId: 'gpt-5.6-luna', workerEffortId: 'low', status: 'configured' as const }

test('the boundary is explained on the worker option itself', () => {
  const display = describeRoutineDelegation({ enabled: false }, null)
  assert.equal(display.selectedId, DELEGATION_OFF_OPTION.id)
  const worker = display.options.find((option) => option.id === 'gpt-5.6-luna')
  assert.match(worker?.description ?? '', /planning, diagnosis and review stay on the main model/i)
  assert.equal(display.note, undefined)
})

test('a session launched under the current preference reads as requested, never enforced', () => {
  const display = describeRoutineDelegation({ enabled: true, codexWorkerModelId: 'gpt-5.6-luna' }, configured)
  assert.equal(display.selectedId, 'gpt-5.6-luna')
  assert.match(display.note ?? '', /not provider-confirmed/)
})

test('a preference the session has not launched under yet says when it applies', () => {
  // Enabled after launch: the policy travels in the adapter environment, so it waits for the next
  // safe creation or resume rather than cancelling the running session.
  assert.match(describeRoutineDelegation({ enabled: true }, null).note ?? '', /next starts or resumes/)
  // Disabled after launch: the running session still carries its launch-time policy.
  assert.match(describeRoutineDelegation({ enabled: false }, configured).note ?? '', /until this conversation restarts/)
})

test('a withheld configuration surfaces its own reason', () => {
  const display = describeRoutineDelegation(
    { enabled: true },
    { ...configured, status: 'unavailable', message: 'This Codex account does not list gpt-5.6-luna.' }
  )
  assert.match(display.note ?? '', /does not list gpt-5\.6-luna/)
})

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { registerDecisionDelegationIpc } from '../src/main/decision-delegation-ipc'
import { DECISION_DELEGATION_CHANNELS } from '../src/shared/ipc-channels'

// Issue #213: the picker's freshness channel. Every call re-asks rather than answering from a
// cached first reading, because the whole reason it exists is a skill installed mid-session.

test('each call re-asks the probe, so a skill installed mid-session is noticed', async () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  let installed = false
  registerDecisionDelegationIpc(
    { handle: (channel, listener) => void handlers.set(channel, listener as (...args: unknown[]) => unknown) },
    () => installed
  )
  const ask = handlers.get(DECISION_DELEGATION_CHANNELS.availability)!
  const event = { sender: {} }

  assert.equal(await ask(event), false)
  installed = true
  assert.equal(await ask(event), true)
})

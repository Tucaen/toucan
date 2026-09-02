import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { settleAgentTurn } from '../src/main/acp-session-manager'

test('a provider turn has no wall-clock deadline', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  let resolveTurn!: (response: { stopReason: string }) => void
  const providerTurn = new Promise<{ stopReason: string }>((resolve) => {
    resolveTurn = resolve
  })

  let settled = false
  const lifecycle = settleAgentTurn('long-running-turn', providerTurn, []).then((result) => {
    settled = true
    return result
  })
  await Promise.resolve()

  context.mock.timers.tick(24 * 60 * 60_000)
  await Promise.resolve()
  assert.equal(settled, false, 'elapsed time alone must never end a provider turn')

  resolveTurn({ stopReason: 'end_turn' })
  const result = await lifecycle
  assert.deepEqual(result.events, [
    { type: 'turn_complete', stopReason: 'end_turn' },
    { type: 'status', status: 'idle' }
  ])
  assert.deepEqual(result.result, { ok: true })
})

test('an explicit provider cancellation has its own terminal outcome', async () => {
  const result = await settleAgentTurn('cancelled-turn', Promise.resolve({ stopReason: 'cancelled' }), [])

  assert.deepEqual(result.events, [
    { type: 'turn_cancelled', turnId: 'cancelled-turn', message: 'Stopped by you.' },
    { type: 'status', status: 'idle' }
  ])
  assert.deepEqual(result.result, { ok: true })
})

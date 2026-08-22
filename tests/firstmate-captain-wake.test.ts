import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import type { AgentPromptResult } from '../src/shared/agent'
import { createCaptainWakeGate } from '../src/main/firstmate-captain-wake'

test('flush delivers the pending wake and resolves its promise with the delivery result', async () => {
  let delivered: string | undefined
  const gate = createCaptainWakeGate({
    deliver: async (text) => { delivered = text; return { ok: true } }
  })
  const promise = gate.enqueue('wake-1')
  gate.flush()
  const result = await promise
  assert.equal(delivered, 'wake-1')
  assert.deepEqual(result, { ok: true })
  gate.dispose()
})

test('flush without a pending wake does not call deliver', () => {
  let called = false
  const gate = createCaptainWakeGate({
    deliver: async () => { called = true; return { ok: true } }
  })
  gate.flush()
  assert.equal(called, false)
  gate.dispose()
})

test('multiple enqueues form a FIFO queue: every message is delivered, in order, none dropped', async () => {
  const deliveries: string[] = []
  const gate = createCaptainWakeGate({
    deliver: async (text) => { deliveries.push(text); return { ok: true } }
  })
  const first = gate.enqueue('wake-1')
  const second = gate.enqueue('wake-2')
  const third = gate.enqueue('wake-3')

  gate.flush()

  assert.deepEqual(await first, { ok: true })
  assert.deepEqual(await second, { ok: true })
  assert.deepEqual(await third, { ok: true })
  assert.deepEqual(deliveries, ['wake-1', 'wake-2', 'wake-3'], 'every enqueued message should be delivered, in submission order')
  gate.dispose()
})

test('a queued wake crossing the checkpoint target remains pending until a safe boundary', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let checkpoints = 0
  let settled = false
  const gate = createCaptainWakeGate({
    deliver: async () => ({ ok: true }),
    requestCheckpoint: () => { checkpoints += 1 },
    checkpointMs: 60_000
  })
  const promise = gate.enqueue('wake-long-tool').then((result) => { settled = true; return result })
  t.mock.timers.tick(120_000)
  assert.equal(settled, false, 'waiting beyond 60 seconds is not a transport failure')
  assert.equal(checkpoints, 0, 'a timer cannot interrupt a non-yielding operation')
  gate.checkpoint()
  assert.equal(checkpoints, 1, 'the next host-visible safe boundary requests a cooperative yield')
  gate.flush()
  assert.deepEqual(await promise, { ok: true })
  gate.dispose()
})

test('a safe boundary before 60 seconds does not interrupt a useful turn', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let checkpoints = 0
  const gate = createCaptainWakeGate({
    deliver: async () => ({ ok: true }),
    requestCheckpoint: () => { checkpoints += 1 },
    checkpointMs: 60_000
  })
  gate.enqueue('wake-waiting')
  t.mock.timers.tick(59_999)
  gate.checkpoint()
  assert.equal(checkpoints, 0)
  gate.dispose()
})

test('forced Stop checkpoint requests one idempotent yield and preserves FIFO delivery', async () => {
  let checkpoints = 0
  const deliveries: string[] = []
  const gate = createCaptainWakeGate({
    deliver: async (text) => { deliveries.push(text); return { ok: true } },
    requestCheckpoint: () => { checkpoints += 1 }
  })
  const first = gate.enqueue('before-stop-1')
  const second = gate.enqueue('before-stop-2')
  gate.checkpoint(true)
  gate.checkpoint(true)
  assert.equal(checkpoints, 1)
  gate.flush()
  assert.deepEqual(await Promise.all([first, second]), [{ ok: true }, { ok: true }])
  assert.deepEqual(deliveries, ['before-stop-1', 'before-stop-2'])
  gate.dispose()
})

test('dispose resolves a pending wake with failure', async () => {
  const gate = createCaptainWakeGate({
    deliver: async () => ({ ok: true })
  })
  const promise = gate.enqueue('wake-dispose')
  gate.dispose()
  const result = await promise
  assert.equal(result.ok, false)
  assert.ok(result.message)
})

test('delivery failure is forwarded to the enqueue caller', async () => {
  const gate = createCaptainWakeGate({
    deliver: async () => ({ ok: false, message: 'ACP error' })
  })
  const promise = gate.enqueue('wake-fail')
  gate.flush()
  const result = await promise
  assert.equal(result.ok, false)
  assert.equal(result.message, 'ACP error')
  gate.dispose()
})

test('delivery exception is caught and forwarded as a failure', async () => {
  const gate = createCaptainWakeGate({
    deliver: async () => { throw new Error('connection lost') }
  })
  const promise = gate.enqueue('wake-throw')
  gate.flush()
  const result = await promise
  assert.equal(result.ok, false)
  assert.ok(result.message?.includes('connection lost'))
  gate.dispose()
})

test('flush after dispose does not call deliver', () => {
  let called = false
  const gate = createCaptainWakeGate({
    deliver: async () => { called = true; return { ok: true } }
  })
  gate.enqueue('wake-after-dispose')
  gate.dispose()
  gate.flush()
  assert.equal(called, false)
  gate.dispose()
})

test('enqueue after dispose resolves with failure', async () => {
  const gate = createCaptainWakeGate({
    deliver: async () => ({ ok: true })
  })
  gate.dispose()
  const result = await gate.enqueue('wake-after-dispose')
  assert.equal(result.ok, false)
  gate.dispose()
})

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

test('multiple enqueues coalesce: only the latest text is delivered and earlier callers resolve ok', async () => {
  const deliveries: string[] = []
  const gate = createCaptainWakeGate({
    deliver: async (text) => { deliveries.push(text); return { ok: true } }
  })
  const first = gate.enqueue('wake-1')
  const second = gate.enqueue('wake-2')
  const third = gate.enqueue('wake-3')

  assert.deepEqual(await first, { ok: true }, 'superseded wake resolves ok')
  assert.deepEqual(await second, { ok: true }, 'superseded wake resolves ok')

  gate.flush()
  assert.deepEqual(await third, { ok: true })
  assert.deepEqual(deliveries, ['wake-3'], 'only the latest text should be delivered')
  gate.dispose()
})

test('timeout expires a pending wake with a visible failure outcome', async () => {
  let expiredText: string | undefined
  const gate = createCaptainWakeGate({
    deliver: async () => ({ ok: true }),
    onExpired: (text) => { expiredText = text },
    timeoutMs: 10
  })
  const promise = gate.enqueue('wake-timeout')
  const result = await promise
  assert.equal(result.ok, false)
  assert.ok(result.message?.includes('expired'), `expected "expired" in message, got: ${result.message}`)
  assert.equal(expiredText, 'wake-timeout')
  gate.dispose()
})

test('flush clears the timeout so it does not fire after delivery', async () => {
  let expired = false
  const gate = createCaptainWakeGate({
    deliver: async () => ({ ok: true }),
    onExpired: () => { expired = true },
    timeoutMs: 20
  })
  const promise = gate.enqueue('wake-no-expire')
  gate.flush()
  await promise
  await new Promise<void>((resolve) => setTimeout(resolve, 50))
  assert.equal(expired, false, 'timeout should have been cleared by flush')
  gate.dispose()
})

test('coalescing resets the timeout so the latest wake gets a full window', async () => {
  let expiredText: string | undefined
  const gate = createCaptainWakeGate({
    deliver: async () => ({ ok: true }),
    onExpired: (text) => { expiredText = text },
    timeoutMs: 30
  })
  gate.enqueue('wake-old')
  await new Promise<void>((resolve) => setTimeout(resolve, 20))
  const second = gate.enqueue('wake-new')
  // The old timer (20ms elapsed of 30ms) should have been replaced by a fresh 30ms timer.
  // If the old timer survived, it would fire in ~10ms.
  await new Promise<void>((resolve) => setTimeout(resolve, 15))
  assert.equal(expiredText, undefined, 'old timer should not have fired')
  // Now wait for the new timer to fire.
  const result = await second
  assert.equal(result.ok, false)
  assert.equal(expiredText, 'wake-new')
  gate.dispose()
})

test('dispose resolves a pending wake with failure', async () => {
  const gate = createCaptainWakeGate({
    deliver: async () => ({ ok: true }),
    timeoutMs: 60_000
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

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { StallTimeoutError, withStallGuard } from '../src/renderer/src/with-stall-guard'

test('resolves with the value once the wrapped promise resolves before the deadline', async () => {
  const result = await withStallGuard(Promise.resolve('done'), 50, 'should not fire')
  assert.equal(result, 'done')
})

test('rejects with the original error when the wrapped promise rejects before the deadline', async () => {
  await assert.rejects(
    withStallGuard(Promise.reject(new Error('boom')), 50, 'should not fire'),
    /boom/
  )
})

test('rejects with a StallTimeoutError when the wrapped promise never settles', async () => {
  const neverSettles = new Promise<void>(() => {})
  await assert.rejects(
    withStallGuard(neverSettles, 10, 'timed out waiting'),
    (error: unknown) => {
      assert.ok(error instanceof StallTimeoutError)
      assert.equal(error.message, 'timed out waiting')
      return true
    }
  )
})

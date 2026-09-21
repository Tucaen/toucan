import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { createPromptWakeGate } from '../src/main/prompt-wake-gate'
import type { AgentPromptResult } from '../src/shared/agent'

const settled = (): { promise: Promise<AgentPromptResult>; resolve(result: AgentPromptResult): void } => {
  let resolve!: (result: AgentPromptResult) => void
  const promise = new Promise<AgentPromptResult>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

test('queued prompts are delivered in order, one at a time', async () => {
  const delivered: string[] = []
  const pending = [settled(), settled(), settled()]
  let started = 0
  const gate = createPromptWakeGate({
    deliver: (payload: string) => {
      delivered.push(payload)
      return pending[started++]!.promise
    }
  })

  const results = [gate.enqueue('one'), gate.enqueue('two'), gate.enqueue('three')]
  assert.deepEqual(delivered, [], 'enqueue alone must not deliver: the turn in flight still owns the session')

  gate.flush()
  assert.deepEqual(delivered, ['one'], 'a flush starts one delivery, not the whole queue at once')

  pending[0]!.resolve({ ok: true })
  await results[0]
  assert.deepEqual(delivered, ['one', 'two'], 'the next payload only goes out once the previous one settles')

  pending[1]!.resolve({ ok: false, message: 'refused' })
  assert.deepEqual(
    await results[1],
    { ok: false, message: 'refused' },
    "each enqueue resolves with its own delivery's result"
  )
  assert.deepEqual(delivered, ['one', 'two', 'three'], 'a failed delivery still drains the rest of the queue')

  pending[2]!.resolve({ ok: true })
  await results[2]
})

test('a flush while a delivery is in flight does not double-send', async () => {
  const delivered: string[] = []
  const first = settled()
  const gate = createPromptWakeGate({
    deliver: (payload: string) => {
      delivered.push(payload)
      return first.promise
    }
  })

  const result = gate.enqueue('only')
  gate.flush()
  gate.flush()
  gate.flush()
  assert.deepEqual(delivered, ['only'])

  first.resolve({ ok: true })
  assert.deepEqual(await result, { ok: true })
  assert.deepEqual(delivered, ['only'])
})

test('a rejected deliver settles its own prompt as a failure instead of leaving it pending', async () => {
  const gate = createPromptWakeGate({
    deliver: () => Promise.reject(new Error('the adapter went away'))
  })

  const result = gate.enqueue('doomed')
  gate.flush()
  assert.deepEqual(await result, { ok: false, message: 'the adapter went away' })
})

test('dispose settles everything still queued and refuses anything enqueued afterwards', async () => {
  const gate = createPromptWakeGate({ deliver: () => Promise.resolve({ ok: true }) })

  const queued = [gate.enqueue('one'), gate.enqueue('two')]
  gate.dispose()

  for (const result of await Promise.all(queued)) {
    assert.deepEqual(result, { ok: false, message: 'The wake gate was disposed.' })
  }
  assert.deepEqual(await gate.enqueue('late'), { ok: false, message: 'The wake gate is disposed.' })

  // A flush after disposal must stay a no-op rather than reviving the drained queue.
  gate.flush()
})

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { createSerialQueue } from '../src/main/serial-queue'

test('tasks run one at a time in submission order', async () => {
  const enqueue = createSerialQueue()
  const order: string[] = []
  let releaseFirst!: () => void
  const gate = new Promise<void>((resolve) => {
    releaseFirst = resolve
  })

  const first = enqueue(async () => {
    order.push('first started')
    await gate
    order.push('first finished')
  })
  const second = enqueue(async () => {
    order.push('second started')
  })

  releaseFirst()
  await Promise.all([first, second])
  assert.deepEqual(order, ['first started', 'first finished', 'second started'])
})

test('a failed task rejects its caller without blocking or poisoning later tasks', async () => {
  const enqueue = createSerialQueue()

  await assert.rejects(
    enqueue(() => Promise.reject(new Error('disk full'))),
    /disk full/
  )
  assert.equal(await enqueue(async () => 'still running'), 'still running')
})

test('returns each task its own result', async () => {
  const enqueue = createSerialQueue()
  const [a, b] = await Promise.all([enqueue(async () => 1), enqueue(async () => 2)])
  assert.equal(a, 1)
  assert.equal(b, 2)
})

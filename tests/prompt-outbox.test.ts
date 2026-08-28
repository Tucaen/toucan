import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  editQueuedPrompt,
  enqueuePrompt,
  takeQueuedPrompt,
  withdrawQueuedPrompt,
  type QueuedPrompt
} from '../src/renderer/src/prompt-outbox'

function entry(id: string, text: string): QueuedPrompt {
  return { id, text, images: [] }
}

test('queued prompts hold their submission order', () => {
  const queue = enqueuePrompt(enqueuePrompt([], entry('a', 'first')), entry('b', 'second'))
  assert.deepEqual(queue.map((item) => item.id), ['a', 'b'])
})

test('a queued prompt can be edited in place without losing its position or its attachments', () => {
  const withImage: QueuedPrompt = { id: 'a', text: 'first', images: [{ id: 'i', data: 'd', mimeType: 'image/png' }] }
  const queue = enqueuePrompt(enqueuePrompt([], withImage), entry('b', 'second'))
  const edited = editQueuedPrompt(queue, 'a', '  rewritten  ')
  assert.deepEqual(edited.map((item) => [item.id, item.text]), [['a', 'rewritten'], ['b', 'second']])
  assert.deepEqual(edited[0].images, withImage.images)
})

test('editing a text-only prompt down to nothing withdraws it, since an empty prompt cannot be sent', () => {
  const queue = enqueuePrompt([], entry('a', 'first'))
  assert.deepEqual(editQueuedPrompt(queue, 'a', '   '), [])
})

test('an image-carrying prompt survives having all of its text removed', () => {
  const queue = enqueuePrompt([], { id: 'a', text: 'first', images: [{ id: 'i', data: 'd', mimeType: 'image/png' }] })
  assert.deepEqual(editQueuedPrompt(queue, 'a', '').map((item) => item.text), [''])
})

test('withdrawing removes exactly one prompt and leaves the rest queued in order', () => {
  const queue = [entry('a', 'first'), entry('b', 'second'), entry('c', 'third')]
  assert.deepEqual(withdrawQueuedPrompt(queue, 'b').map((item) => item.id), ['a', 'c'])
})

test('withdrawing or editing an id that is no longer queued is a no-op, not a crash', () => {
  const queue = [entry('a', 'first')]
  assert.deepEqual(withdrawQueuedPrompt(queue, 'gone'), queue)
  assert.deepEqual(editQueuedPrompt(queue, 'gone', 'x'), queue)
})

test('taking a prompt hands back that entry and the queue without it, so dispatch cannot double-send', () => {
  const queue = [entry('a', 'first'), entry('b', 'second')]
  const taken = takeQueuedPrompt(queue, 'a')
  assert.deepEqual(taken.entry, entry('a', 'first'))
  assert.deepEqual(taken.rest.map((item) => item.id), ['b'])

  const missing = takeQueuedPrompt(taken.rest, 'a')
  assert.equal(missing.entry, null)
  assert.equal(missing.rest, taken.rest)
})

test('taking without an id takes the head of the queue', () => {
  const queue = [entry('a', 'first'), entry('b', 'second')]
  const taken = takeQueuedPrompt(queue)
  assert.deepEqual(taken.entry, entry('a', 'first'))
  assert.deepEqual(taken.rest.map((item) => item.id), ['b'])
  assert.equal(takeQueuedPrompt([]).entry, null)
})

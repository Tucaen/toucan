import { strict as assert } from 'node:assert'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import { registerDictationCleanupIpc } from '../src/main/dictation-cleanup-ipc'
import { createDictationCleaner } from '../src/main/dictation-cleanup'
import { DICTATION_CLEANUP_CHANNELS } from '../src/shared/ipc-channels'

test('cleanup cancellation is scoped to its window and closing the window aborts it', async () => {
  const handlers = new Map<string, (event: { sender: EventEmitter }, ...args: unknown[]) => unknown>()
  let signal: AbortSignal | undefined
  const shutdown = registerDictationCleanupIpc(
    {
      handle: (channel, handler) => {
        handlers.set(channel, handler)
      }
    },
    createDictationCleaner({
      run: async (_input, _model, currentSignal) => {
        signal = currentSignal
        return new Promise(() => {})
      }
    })
  )
  const sender = new EventEmitter()
  const request = { id: 'dictation-1', text: 'raw', context: '', preference: { enabled: true } }
  const pending = handlers.get(DICTATION_CLEANUP_CHANNELS.clean)!({ sender }, request)
  handlers.get(DICTATION_CLEANUP_CHANNELS.cancel)!({ sender: new EventEmitter() }, request.id)
  assert.equal(signal?.aborted, false)
  sender.emit('destroyed')
  assert.equal(((await pending) as { text: string }).text, 'raw')
  assert.equal(signal?.aborted, true)
  assert.equal(sender.listenerCount('destroyed'), 0)
  shutdown()
})

test('a malformed request is refused with the text it carried, without launching anything', async () => {
  const handlers = new Map<string, (event: { sender: EventEmitter }, ...args: unknown[]) => unknown>()
  let launches = 0
  const shutdown = registerDictationCleanupIpc(
    {
      handle: (channel, handler) => {
        handlers.set(channel, handler)
      }
    },
    createDictationCleaner({
      run: async () => {
        launches += 1
        return new Promise(() => {})
      }
    })
  )
  const clean = handlers.get(DICTATION_CLEANUP_CHANNELS.clean)!
  const valid = { id: 'dictation-1', text: 'raw', context: '', preference: { enabled: true } }
  for (const [name, request] of [
    ['nothing at all', null],
    ['a missing id', { ...valid, id: undefined }],
    ['an empty id', { ...valid, id: '' }],
    ['an oversize id', { ...valid, id: 'x'.repeat(101) }],
    ['a nonstring text', { ...valid, text: 42 }],
    ['oversize text', { ...valid, text: 'x'.repeat(50_001) }],
    ['a missing context', { ...valid, context: undefined }],
    // The renderer already trims context to the decoder's window; a larger one is not this seam's.
    ['oversize context', { ...valid, context: 'x'.repeat(1_001) }],
    ['a missing preference', { ...valid, preference: undefined }],
    ['an unknown model', { ...valid, preference: { enabled: true, claudeModelId: 'opus' } }]
  ] as const) {
    const result = (await clean({ sender: new EventEmitter() }, request)) as { status: string; text: string }
    const carried = (request as { text?: unknown } | null)?.text
    assert.equal(result.status, 'fallback', name)
    // The refusal hands the dictation back rather than dropping it; a nonstring one has none.
    assert.equal(result.text === (typeof carried === 'string' ? carried : ''), true, name)
  }
  // Same window, same id, while the first is still running: the second is refused, not raced.
  const sender = new EventEmitter()
  const pending = clean({ sender }, valid)
  const duplicate = (await clean({ sender }, valid)) as { status: string; text: string; message?: string }
  assert.equal(duplicate.status, 'fallback')
  assert.equal(duplicate.text, 'raw')
  assert.match(duplicate.message!, /already running/)
  // A different window with the same id is a different job and does run.
  const other = new EventEmitter()
  void clean({ sender: other }, valid)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(launches, 2)
  sender.emit('destroyed')
  other.emit('destroyed')
  await pending
  shutdown()
})

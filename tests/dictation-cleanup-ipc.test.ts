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

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { createDictationCleaner } from '../src/main/dictation-cleanup'

test('timeout and cancellation release a stalled cleanup and preserve the raw text', async () => {
  let launchedSignal: AbortSignal | undefined
  const cleaner = createDictationCleaner({
    timeoutMs: 10,
    run: async (_input, _model, signal) => {
      launchedSignal = signal
      return new Promise(() => {})
    }
  })
  const timedOut = await cleaner.clean('raw', '', { enabled: true })
  assert.equal(timedOut.text, 'raw')
  assert.match(timedOut.message!, /timed out/)
  assert.equal(launchedSignal?.aborted, true)
  const controller = new AbortController()
  const pending = cleaner.clean('raw again', '', { enabled: true }, controller.signal)
  controller.abort()
  const cancelled = await pending
  assert.equal(cancelled.text, 'raw again')
  assert.match(cancelled.message!, /cancelled/)
  assert.equal(launchedSignal?.aborted, true)
})

test('a failed or malformed cleanup keeps the raw dictation and reports why', async () => {
  const raw = ' um our our options '
  for (const output of [
    'not JSON',
    JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'Sign in' }),
    JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: '' }),
    JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'Here is the corrected transcript: Our options.'
    })
  ]) {
    const cleaner = createDictationCleaner({ run: async () => output })
    const result = await cleaner.clean(raw, '', { enabled: true })
    assert.equal(result.status, 'fallback')
    assert.equal(result.text, raw)
    assert.equal(result.requestedModelId, 'haiku')
    assert.ok(result.message)
  }
  const result = await createDictationCleaner({
    run: async () => {
      throw new Error('Claude is unavailable')
    }
  }).clean(raw, '', { enabled: true })
  assert.equal(result.text, raw)
  assert.match(result.message!, /unavailable/)
})

test('cleanup is off by default and preserves every byte without invoking a model', async () => {
  const cleaner = createDictationCleaner({
    run: async () => {
      throw new Error('must not run')
    }
  })
  const raw = '  um our our options\n'
  assert.deepEqual(await cleaner.clean(raw, ''), { status: 'off', text: raw })
})

test('opt-in requests the chosen model with context and accepts a successful transcript', async () => {
  const cleaner = createDictationCleaner({
    run: async (input, model) => {
      assert.equal(model, 'sonnet')
      assert.deepEqual(JSON.parse(input), { transcript: 'um our our options', context: 'Toucan settings' })
      return JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Our options.' })
    }
  })
  assert.deepEqual(
    await cleaner.clean('um our our options', 'Toucan settings', { enabled: true, claudeModelId: 'sonnet' }),
    {
      status: 'cleaned',
      text: 'Our options.',
      requestedModelId: 'sonnet'
    }
  )
})

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { createDictationCleaner } from '../src/main/dictation-cleanup'
import { claudeModelLabel } from '../src/shared/dictation-cleanup'

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
      requestedModelId: 'sonnet',
      servedModel: undefined
    }
  )
})

test('a cleaned result reports the model the response was billed to, not the one requested', async () => {
  const envelope = (modelUsage: unknown): string =>
    JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Our options.', modelUsage })
  const clean = async (modelUsage: unknown): Promise<string | undefined> =>
    (
      await createDictationCleaner({ run: async () => envelope(modelUsage) }).clean('um our our options', '', {
        enabled: true
      })
    ).servedModel

  // The canonical name is preferred over the dated build the turn was billed under.
  assert.equal(
    await clean({ 'claude-haiku-4-5-20251001': { canonicalModel: 'claude-haiku-4-5', outputTokens: 35 } }),
    'claude-haiku-4-5'
  )
  assert.equal(await clean({ 'claude-sonnet-4-5-20250929': { outputTokens: 35 } }), 'claude-sonnet-4-5-20250929')
  // Nothing to report is reported as nothing; the UI says "requested" rather than inventing a model.
  for (const absent of [undefined, null, {}, 'claude-haiku-4-5']) assert.equal(await clean(absent), undefined)
})

test('a served model id is labelled as a version and an unparseable one is shown verbatim', () => {
  assert.equal(claudeModelLabel('claude-haiku-4-5-20251001'), 'Haiku 4.5')
  assert.equal(claudeModelLabel('claude-sonnet-4-5'), 'Sonnet 4.5')
  assert.equal(claudeModelLabel('claude-opus-5'), 'Opus 5')
  assert.equal(claudeModelLabel('claude-3-5-sonnet-20241022'), 'claude-3-5-sonnet-20241022')
  assert.equal(claudeModelLabel(''), '')
})

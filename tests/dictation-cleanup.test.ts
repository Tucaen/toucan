import { strict as assert } from 'node:assert'
import { test } from 'vitest'
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

test('a transcript that itself begins like a preamble is kept, not rejected as one', async () => {
  const cleaned = async (raw: string, result: string): Promise<{ status: string; text: string }> =>
    createDictationCleaner({
      run: async () => JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result })
    }).clean(raw, '', { enabled: true })

  // #221: the speaker really did start with "Here's" - polishing that sentence must not fail.
  for (const [raw, polished] of [
    ["here's what I want you to change um in the composer", "Here's what I want you to change in the composer."],
    ['sure, go ahead and and rename it', 'Sure, go ahead and rename it.'],
    ['Here is the corrected transcript I promised', 'Here is the corrected transcript I promised.']
  ]) {
    const result = await cleaned(raw, polished)
    assert.equal(result.status, 'cleaned')
    assert.equal(result.text, polished)
  }
  // A preamble the speaker never uttered is still a rejected response.
  const invented = await cleaned('um our our options', "Sure! Here's the corrected transcript: Our options.")
  assert.equal(invented.status, 'fallback')
  assert.equal(invented.text, 'um our our options')
})

test('the served model is the entry that did the work, not whichever key came first', async () => {
  const clean = async (modelUsage: unknown, claudeModelId: 'haiku' | 'sonnet' = 'haiku'): Promise<string | undefined> =>
    (
      await createDictationCleaner({
        run: async () =>
          JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Our options.', modelUsage })
      }).clean('um our our options', '', { enabled: true, claudeModelId })
    ).servedModel

  // A single -p turn bills more than one model (docs/plans/delegation-evidence.md); the one that
  // emitted the transcript is the one that served it.
  const twoModels = {
    'claude-sonnet-4-5-20250929': { canonicalModel: 'claude-sonnet-4-5', outputTokens: 3 },
    'claude-haiku-4-5-20251001': { canonicalModel: 'claude-haiku-4-5', outputTokens: 41 }
  }
  assert.equal(await clean(twoModels), 'claude-haiku-4-5')
  // Tied or unreported token counts fall back to the requested family, and to "requested" when
  // even that cannot single one out.
  const tied = {
    'claude-sonnet-4-5-20250929': { outputTokens: 7 },
    'claude-haiku-4-5-20251001': { outputTokens: 7 }
  }
  assert.equal(await clean(tied, 'sonnet'), 'claude-sonnet-4-5-20250929')
  assert.equal(await clean({ 'claude-sonnet-4-5': {}, 'claude-sonnet-4-5-20250929': {} }, 'sonnet'), undefined)
  assert.equal(await clean(tied, 'haiku'), 'claude-haiku-4-5-20251001')
  // The family is looked for in the name that would be shown, so an alias key still resolves.
  const aliased = {
    'claude-sonnet-4-5-20250929': { outputTokens: 7 },
    'anthropic.internal-alias': { canonicalModel: 'claude-haiku-4-5', outputTokens: 7 }
  }
  assert.equal(await clean(aliased, 'haiku'), 'claude-haiku-4-5')
})

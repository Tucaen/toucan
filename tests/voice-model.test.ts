import { strict as assert } from 'node:assert'
import { test } from 'vitest'
import { voiceModelProgress } from '../src/shared/voice-model'

/**
 * The microphone button shows a real percentage during a four-minute fetch, so the one rule that
 * turns a status into that fraction has to answer for every state a fetch passes through.
 */

test('only a download in flight with a known total reports progress', () => {
  assert.equal(voiceModelProgress({ phase: 'downloading', receivedBytes: 400, totalBytes: 1_600 }), 0.25)
  assert.equal(voiceModelProgress({ phase: 'missing' }), 0)
  assert.equal(voiceModelProgress({ phase: 'ready' }), 0)
  assert.equal(voiceModelProgress({ phase: 'error', message: 'ENOTFOUND' }), 0)
})

test('a total the server never sent reads as zero rather than as NaN or Infinity', () => {
  assert.equal(voiceModelProgress({ phase: 'downloading', receivedBytes: 0, totalBytes: 0 }), 0)
  assert.equal(voiceModelProgress({ phase: 'downloading', receivedBytes: 100, totalBytes: -1 }), 0)
})

test('a server that undercounts its own body cannot push the bar past full', () => {
  assert.equal(voiceModelProgress({ phase: 'downloading', receivedBytes: 2_000, totalBytes: 1_600 }), 1)
})

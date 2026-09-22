import { strict as assert } from 'node:assert'
import { describe, test } from 'vitest'
import {
  WHISPER_DOWNLOAD_GIGABYTES,
  WHISPER_ENGINE_ENTRIES,
  WHISPER_ENGINE_ZIP,
  WHISPER_MODEL
} from '../src/shared/whisper-assets'
import { wavBytes, whisperAudioContext } from '../src/main/whisper-engine'

/**
 * The pinned speech assets. There is one copy of the pins now - `scripts/whisper-files.mjs` loads
 * these very constants out of `.test-out` - so what is left to check is that the values say what
 * they are meant to say, not that a second file still agrees with them (#230).
 */

describe('whisper asset pins', () => {
  test('the extraction list names the binaries the engine actually needs', () => {
    assert.ok(WHISPER_ENGINE_ENTRIES.includes('whisper-server.exe'), 'dictation decodes through the server')
    assert.ok(WHISPER_ENGINE_ENTRIES.includes('whisper-cli.exe'), 'the WER harness scores through the CLI')
    assert.ok(WHISPER_ENGINE_ENTRIES.includes('whisper.dll'))
    assert.ok(WHISPER_ENGINE_ENTRIES.includes('ggml.dll'))
  })

  test('the download label the button shows matches the pinned model size', () => {
    const gigabytes = (WHISPER_ENGINE_ZIP.size + WHISPER_MODEL.size) / 1e9
    assert.equal(WHISPER_DOWNLOAD_GIGABYTES, `${gigabytes.toFixed(1)} GB`)
  })
})

describe('whisperAudioContext', () => {
  test('trims the encoder context to the audio, with a floor and headroom against hallucination', () => {
    // Whisper always encodes a 30 s window (1500 context tokens); trimming is what makes a short
    // dictation decode in seconds instead of paying for the whole window.
    assert.equal(whisperAudioContext(16_000 * 30), 1500)
    assert.equal(whisperAudioContext(16_000 * 60), 1500, 'longer audio decodes in full windows')
    assert.equal(whisperAudioContext(16_000 * 2), 256, 'very short clips sit on the floor')
    assert.equal(whisperAudioContext(16_000 * 10), 500 + 128)
    assert.equal(whisperAudioContext(0), 256)
  })
})

describe('wavBytes', () => {
  test('wraps samples in the 16 kHz mono 16-bit header whisper-server expects', () => {
    const bytes = Buffer.from(wavBytes(new Float32Array([0, 0.5, -0.5])))
    assert.equal(bytes.toString('ascii', 0, 4), 'RIFF')
    assert.equal(bytes.toString('ascii', 8, 12), 'WAVE')
    assert.equal(bytes.readUInt16LE(20), 1, 'PCM format')
    assert.equal(bytes.readUInt16LE(22), 1, 'mono')
    assert.equal(bytes.readUInt32LE(24), 16_000)
    assert.equal(bytes.readUInt16LE(34), 16, 'bits per sample')
    assert.equal(bytes.readUInt32LE(40), 6, 'data chunk bytes: three 16-bit samples')
    assert.equal(bytes.length, 44 + 6)
    assert.equal(bytes.readInt16LE(44), 0)
    assert.equal(bytes.readInt16LE(46), Math.round(0.5 * 32767))
    assert.equal(bytes.readInt16LE(48), Math.round(-0.5 * 32767))
  })
})

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import {
  WHISPER_DOWNLOAD_GIGABYTES,
  WHISPER_ENGINE_BUILD,
  WHISPER_ENGINE_ENTRIES,
  WHISPER_ENGINE_ZIP,
  WHISPER_MODEL
} from '../src/shared/whisper-assets'
import { wavBytes, whisperAudioContext } from '../src/main/whisper-engine'

/**
 * The pinned speech assets. The app reads its pins from `shared/whisper-assets.ts`; the WER
 * harness cannot import TypeScript, so `scripts/whisper-files.mjs` restates them - and this test is
 * what keeps the two files the same, so the harness never measures a different engine than the one
 * Toucan dictates with.
 */

const harness = readFileSync(join(process.cwd(), 'scripts', 'whisper-files.mjs'), 'utf8')

describe('whisper asset pins', () => {
  test('the WER harness carries the same engine and model pins as the app', () => {
    for (const value of [
      WHISPER_ENGINE_BUILD,
      WHISPER_ENGINE_ZIP.sha256,
      String(WHISPER_ENGINE_ZIP.size),
      WHISPER_MODEL.url,
      WHISPER_MODEL.sha256,
      String(WHISPER_MODEL.size)
    ]) {
      assert.ok(harness.includes(value), `scripts/whisper-files.mjs is missing the pinned value ${value}`)
    }
    for (const entry of WHISPER_ENGINE_ENTRIES) {
      assert.ok(harness.includes(`'${entry}'`), `scripts/whisper-files.mjs is missing the engine entry ${entry}`)
    }
  })

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

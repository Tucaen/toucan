import { strict as assert } from 'node:assert'
import { describe, test } from 'vitest'
import {
  decodePcm16,
  downmixToMono,
  encodePcm16,
  isRemoteVoiceContentType,
  parseRemoteTranscriptionReply,
  REMOTE_VOICE_BODY_LIMIT,
  REMOTE_VOICE_CONTENT_TYPE,
  REMOTE_VOICE_MAX_SECONDS,
  REMOTE_VOICE_SAMPLE_RATE,
  remoteVoiceBodyProblem,
  resampleLinear
} from '../src/shared/remote-voice'

/**
 * The wire contract for a phone handing the host audio to transcribe. Raw 16 kHz mono PCM rather
 * than a container format on purpose: the host has no audio decoder and phones disagree about which
 * codec their recorder produces, so the phone does the one conversion every browser can do (float
 * samples to 16-bit) and the host reads bytes it can hand straight to the model.
 */
describe('remote voice contract', () => {
  test('the content type names 16 kHz linear PCM and is matched loosely', () => {
    assert.equal(REMOTE_VOICE_CONTENT_TYPE, 'audio/L16; rate=16000; channels=1')
    assert.equal(isRemoteVoiceContentType(REMOTE_VOICE_CONTENT_TYPE), true)
    assert.equal(isRemoteVoiceContentType('audio/l16;rate=16000'), true)
    assert.equal(isRemoteVoiceContentType('Audio/L16; Rate=16000; Channels=1'), true)
  })

  test('other media types, other rates and stereo are refused', () => {
    assert.equal(isRemoteVoiceContentType(undefined), false)
    assert.equal(isRemoteVoiceContentType('audio/webm'), false)
    assert.equal(isRemoteVoiceContentType('audio/L16; rate=44100'), false)
    assert.equal(isRemoteVoiceContentType('audio/L16'), false)
    assert.equal(isRemoteVoiceContentType('audio/L16; rate=16000; channels=2'), false)
    assert.equal(isRemoteVoiceContentType('application/json'), false)
  })

  test('the body limit is a fixed number of seconds of audio', () => {
    assert.equal(REMOTE_VOICE_BODY_LIMIT, REMOTE_VOICE_SAMPLE_RATE * 2 * REMOTE_VOICE_MAX_SECONDS)
    assert.equal(remoteVoiceBodyProblem(REMOTE_VOICE_BODY_LIMIT), null)
    assert.match(remoteVoiceBodyProblem(REMOTE_VOICE_BODY_LIMIT + 2) ?? '', /too long/)
  })

  test('an empty or half-sample body is not audio', () => {
    assert.match(remoteVoiceBodyProblem(0) ?? '', /no audio/i)
    assert.match(remoteVoiceBodyProblem(3) ?? '', /not 16-bit/i)
    assert.equal(remoteVoiceBodyProblem(3200), null)
  })

  test('PCM encoding is little-endian 16-bit, clamped, and round-trips', () => {
    const encoded = encodePcm16(new Float32Array([0, 0.5, -0.5, 1, -1, 2, -2]))
    assert.equal(encoded.byteLength, 14)
    // 0.5 * 32767 rounds to 16384 (0x4000), stored low byte first.
    assert.deepEqual([...encoded.slice(2, 4)], [0x00, 0x40])
    // Out-of-range samples clamp instead of wrapping into the opposite sign.
    const decoded = decodePcm16(encoded)
    assert.equal(decoded.length, 7)
    assert.ok(Math.abs(decoded[1] - 0.5) < 0.001)
    assert.ok(Math.abs(decoded[2] + 0.5) < 0.001)
    assert.ok(decoded[3] > 0.999 && decoded[5] > 0.999)
    assert.ok(decoded[4] < -0.999 && decoded[6] < -0.999)
  })

  test('decoding ignores a trailing odd byte rather than throwing', () => {
    assert.equal(decodePcm16(new Uint8Array([0, 0, 0x7f])).length, 1)
  })

  test('resampling changes the length by the rate ratio and keeps a constant signal', () => {
    const input = new Float32Array(48_000).fill(0.25)
    const output = resampleLinear(input, 48_000, 16_000)
    assert.equal(output.length, 16_000)
    assert.ok(output.every((sample) => Math.abs(sample - 0.25) < 1e-6))
    // Equal rates are a copy, not the same buffer.
    const same = resampleLinear(input, 16_000, 16_000)
    assert.notEqual(same, input)
    assert.equal(same.length, input.length)
  })

  test('downmix averages channels so a right-channel-only microphone is not silence', () => {
    const left = new Float32Array([0, 0, 0])
    const right = new Float32Array([0.5, -0.5, 1])
    assert.deepEqual([...downmixToMono([left, right])], [0.25, -0.25, 0.5])
    assert.deepEqual([...downmixToMono([])], [])
  })

  test('a reply is text or an error, never both, never neither', () => {
    assert.deepEqual(parseRemoteTranscriptionReply({ text: 'hello' }), { ok: true, text: 'hello' })
    assert.deepEqual(parseRemoteTranscriptionReply({ error: 'busy' }), { ok: false, message: 'busy' })
    assert.equal(parseRemoteTranscriptionReply({ text: 5 }), null)
    assert.equal(parseRemoteTranscriptionReply(null), null)
    assert.equal(parseRemoteTranscriptionReply('hello'), null)
  })
})

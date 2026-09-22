/**
 * The contract for dictating on a phone and transcribing on the desktop.
 *
 * A phone browser will not run Toucan's speech model - a 1.6 GB checkpoint and a desktop-class
 * CPU - so when the phone has no speech recognizer of its own it records and lets the host
 * transcribe. What travels is deliberately the dumbest possible audio: raw 16 kHz mono 16-bit PCM.
 * Every browser can produce it from a microphone with plain WebAudio, the host has no audio
 * decoder and needs none, and the model consumes exactly this. A container format (WebM, MP4)
 * would put codec support on both ends and differ by browser; this puts one multiply on the phone.
 * The desktop's own dictation sends the very same PCM over IPC, so both surfaces share one bound
 * and one verdict shape.
 *
 * Both ends read their rules here, so what the phone sends is what the host accepts.
 */

/** The model's own input rate; the phone resamples to it before sending. */
export const REMOTE_VOICE_SAMPLE_RATE = 16_000

/** The longest dictation a phone may send in one request. Dictation is a prompt, not a lecture. */
export const REMOTE_VOICE_MAX_SECONDS = 180

/** Bytes: 16-bit samples at the fixed rate for the maximum duration. */
export const REMOTE_VOICE_BODY_LIMIT = REMOTE_VOICE_SAMPLE_RATE * 2 * REMOTE_VOICE_MAX_SECONDS

/** `audio/L16` is the registered type for linear PCM (RFC 2586); the rate parameter is mandatory. */
export const REMOTE_VOICE_CONTENT_TYPE = `audio/L16; rate=${REMOTE_VOICE_SAMPLE_RATE}; channels=1`

/**
 * Whether a request body claims to be the PCM this contract wants. Matched on the parsed media type
 * and parameters rather than on a string compare, because proxies and browsers re-serialize
 * parameters with their own spacing and casing.
 */
export function isRemoteVoiceContentType(value: string | undefined): boolean {
  if (!value) return false
  const [type, ...parameters] = value.split(';').map((part) => part.trim().toLowerCase())
  if (type !== 'audio/l16') return false
  const params = new Map<string, string>()
  for (const parameter of parameters) {
    const equals = parameter.indexOf('=')
    if (equals === -1) continue
    params.set(parameter.slice(0, equals).trim(), parameter.slice(equals + 1).trim())
  }
  if (params.get('rate') !== String(REMOTE_VOICE_SAMPLE_RATE)) return false
  const channels = params.get('channels')
  return channels === undefined || channels === '1'
}

/** Said when a recording exceeds the bound, whether the host counted the bytes before or as they arrived. */
export const REMOTE_VOICE_TOO_LONG_MESSAGE = `The recording was too long. Dictations are limited to ${REMOTE_VOICE_MAX_SECONDS} seconds.`

/** Why a body of this many bytes cannot be transcribed, or null when it can. */
export function remoteVoiceBodyProblem(byteLength: number): string | null {
  if (byteLength === 0) return 'The recording contained no audio.'
  if (byteLength % 2 !== 0) return 'The recording was not 16-bit PCM.'
  if (byteLength > REMOTE_VOICE_BODY_LIMIT) return REMOTE_VOICE_TOO_LONG_MESSAGE
  return null
}

/** Float samples in [-1, 1] to little-endian signed 16-bit, clamped rather than wrapped. */
export function encodePcm16(samples: Float32Array): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(samples.length * 2)
  const view = new DataView(bytes.buffer)
  for (const [index, sample] of samples.entries()) {
    const clamped = Math.max(-1, Math.min(1, sample))
    view.setInt16(index * 2, Math.round(clamped * 32767), true)
  }
  return bytes
}

/** The inverse of `encodePcm16`. A trailing odd byte is ignored: it is not a sample. */
export function decodePcm16(bytes: Uint8Array): Float32Array {
  const count = Math.floor(bytes.byteLength / 2)
  const view = new DataView(bytes.buffer, bytes.byteOffset, count * 2)
  const samples = new Float32Array(count)
  for (let index = 0; index < count; index += 1) samples[index] = view.getInt16(index * 2, true) / 32767
  return samples
}

/**
 * Linear resampling. Speech at 16 kHz does not need a windowed sinc, and this runs on a phone's
 * main thread while the user is still talking. Always returns a new buffer so callers may keep it.
 */
export function resampleLinear(input: Float32Array, inputRate: number, outputRate: number): Float32Array {
  if (inputRate === outputRate) return new Float32Array(input)
  const ratio = inputRate / outputRate
  const length = Math.floor(input.length / ratio)
  const output = new Float32Array(length)
  for (let index = 0; index < length; index += 1) {
    const position = index * ratio
    const left = Math.floor(position)
    const right = Math.min(left + 1, input.length - 1)
    const weight = position - left
    output[index] = (input[left] ?? 0) * (1 - weight) + (input[right] ?? 0) * weight
  }
  return output
}

/**
 * Averages capture channels. Plenty of headsets open as stereo with the microphone on one channel
 * and digital silence on the other; reading only channel 0 would transcribe nothing, quietly.
 */
export function downmixToMono(channels: readonly Float32Array[]): Float32Array {
  const [first] = channels
  if (!first) return new Float32Array(0)
  const mono = new Float32Array(first.length)
  for (const channel of channels) {
    for (let index = 0; index < mono.length; index += 1)
      mono[index] = (mono[index] ?? 0) + (channel[index] ?? 0) / channels.length
  }
  return mono
}

export type RemoteTranscriptionResult = { ok: true; text: string } | { ok: false; message: string }

/** The host's reply body, read strictly: a text or an error, and nothing else is a reply. */
export function parseRemoteTranscriptionReply(payload: unknown): RemoteTranscriptionResult | null {
  if (!payload || typeof payload !== 'object') return null
  const body = payload as { text?: unknown; error?: unknown }
  if (typeof body.text === 'string') return { ok: true, text: body.text }
  if (typeof body.error === 'string') return { ok: false, message: body.error }
  return null
}

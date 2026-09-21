import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { availableParallelism } from 'node:os'
import { encodePcm16, resampleLinear, REMOTE_VOICE_SAMPLE_RATE } from '../shared/remote-voice'
import { hiddenProcessOptions } from './background-process'
import type { VoiceEngine } from './voice-transcription'

/**
 * The whisper.cpp engine behind `voice-transcription.ts`: one `whisper-server` child process with
 * the checkpoint loaded, spoken to over loopback HTTP.
 *
 * A child process rather than an in-process binding, deliberately: the 1.6 GB model load is paid
 * once and amortized across dictations (the policy module decides how long it stays resident), and
 * a native crash takes the helper down, not Toucan. The listener binds 127.0.0.1 on a port picked
 * by the OS and is torn down with the engine - it is not a network surface, and the phone's own
 * route stays `POST /api/transcribe` on the remote server. whisper-server offers no authentication,
 * so another *local* process could reach the port while a dictation keeps it alive; it serves
 * nothing but transcription of audio it is handed, and a local process hostile enough to abuse
 * that already runs as the same user. Judged acceptable and noted rather than guarded.
 *
 * Whisper is a batch model decoding the whole utterance with full right-context, which is the
 * point of #214: punctuation comes from content rather than pause timing, and a thinking pause is
 * not a sentence boundary. `language=auto` makes both surfaces multilingual; `prompt` biases the
 * decoder towards the dictation context the way Moonshine's `setContext` used to.
 */

export const VOICE_MODEL_MISSING_MESSAGE = 'The desktop has not downloaded its speech model yet.'

export interface WhisperEngineOptions {
  serverPath: string
  modelPath: string
  log: (message: string) => void
  /** Injectable for tests: how often and how long to poll the child for readiness. */
  pollIntervalMs?: number
}

export async function loadWhisperEngine(options: WhisperEngineOptions): Promise<VoiceEngine> {
  const pollIntervalMs = options.pollIntervalMs ?? 250
  const port = await freePort()
  const child = spawn(
    options.serverPath,
    [
      '--model',
      options.modelPath,
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '--threads',
      String(decodeThreads()),
      '--inference-path',
      '/inference',
      // Without this, silence decodes to a literal "[BLANK_AUDIO]" - which would land in a draft.
      '--suppress-nst'
    ],
    // stdio ignored: the server logs every request to stderr, and a pipe nobody drains would fill
    // its buffer and wedge the child mid-dictation.
    hiddenProcessOptions({ stdio: 'ignore' as const })
  )
  let exited = false
  child.on('exit', (code) => {
    exited = true
    options.log(`whisper-server exited with code ${code ?? 'unknown'}.`)
  })
  child.on('error', () => {
    exited = true
  })

  const base = `http://127.0.0.1:${port}`
  // Readiness is the server answering /health, which it only does once the model is loaded. The
  // caller bounds this wait with its own stall guard; what is handled here is the child dying,
  // which must reject rather than poll a corpse until the guard fires.
  for (;;) {
    if (exited) throw new Error('The speech engine exited while loading its model.')
    try {
      const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(5_000) })
      if (response.ok) break
    } catch {
      // Not listening yet.
    }
    await sleep(pollIntervalMs)
  }

  return {
    async transcribe(audio, sampleRate, request): Promise<string> {
      if (exited) throw new Error('The speech engine is not running.')
      const samples =
        sampleRate === REMOTE_VOICE_SAMPLE_RATE ? audio : resampleLinear(audio, sampleRate, REMOTE_VOICE_SAMPLE_RATE)
      const form = new FormData()
      form.set('file', new Blob([wavBytes(samples)], { type: 'audio/wav' }), 'dictation.wav')
      form.set('response_format', 'json')
      form.set('temperature', '0.0')
      form.set('language', request?.language ?? 'auto')
      form.set('audio_ctx', String(whisperAudioContext(samples.length)))
      if (request?.prompt) form.set('prompt', request.prompt)
      // A recording is bounded, so its decode has a real deadline - without one, a wedged child
      // blocks the transcriber's serialized queue forever and the idle release never arms.
      const response = await fetch(`${base}/inference`, {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(DECODE_TIMEOUT_MS)
      })
      if (!response.ok) throw new Error(`The speech engine refused the recording (${response.status}).`)
      const body = (await response.json()) as { text?: unknown; error?: unknown }
      if (typeof body.text !== 'string') {
        throw new Error(typeof body.error === 'string' ? body.error : 'The speech engine returned no text.')
      }
      return body.text
    },
    close(): void {
      child.kill()
    }
  }
}

/** The longest a bounded recording's decode may take before it is a wedge rather than work. */
const DECODE_TIMEOUT_MS = 5 * 60_000

/** How many threads a decode gets: most of the machine, but never all of it out from under the UI. */
function decodeThreads(): number {
  return Math.min(16, Math.max(2, availableParallelism() - 4))
}

// Whisper's fixed encoder geometry: 1500 context tokens per 30-second window.
const FULL_AUDIO_CONTEXT = 1500
const FULL_WINDOW_SAMPLES = REMOTE_VOICE_SAMPLE_RATE * 30

/**
 * The encoder context a recording of this many 16 kHz samples needs, with headroom. Whisper always
 * encodes a full 30-second window, so a two-sentence dictation costs the same as thirty seconds of
 * speech unless the context is trimmed to the audio - which is the difference between ~15 s and
 * ~3 s per decode on a desktop CPU. The floor and the headroom are what keep it from hallucinating
 * on very short clips; measured in #214, and re-measurable with `npm run voice:wer`.
 */
export function whisperAudioContext(sampleCount: number): number {
  if (sampleCount >= FULL_WINDOW_SAMPLES) return FULL_AUDIO_CONTEXT
  const proportional = Math.ceil((sampleCount / FULL_WINDOW_SAMPLES) * FULL_AUDIO_CONTEXT)
  return Math.min(FULL_AUDIO_CONTEXT, Math.max(256, proportional + 128))
}

/** A port the OS just proved free. The tiny race until the child binds it is retried by `ensure`. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      probe.close(() =>
        typeof address === 'object' && address ? resolve(address.port) : reject(new Error('No free port.'))
      )
    })
  })
}

/** A minimal 16 kHz mono 16-bit PCM WAV around the samples; whisper-server reads nothing else raw. */
export function wavBytes(samples: Float32Array): Uint8Array<ArrayBuffer> {
  const pcm = encodePcm16(samples)
  const bytes = new Uint8Array(44 + pcm.byteLength)
  const view = new DataView(bytes.buffer)
  const writeAscii = (offset: number, text: string): void => {
    for (let index = 0; index < text.length; index += 1) bytes[offset + index] = text.charCodeAt(index)
  }
  writeAscii(0, 'RIFF')
  view.setUint32(4, 36 + pcm.byteLength, true)
  writeAscii(8, 'WAVE')
  writeAscii(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, REMOTE_VOICE_SAMPLE_RATE, true)
  view.setUint32(28, REMOTE_VOICE_SAMPLE_RATE * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeAscii(36, 'data')
  view.setUint32(40, pcm.byteLength, true)
  bytes.set(pcm, 44)
  return bytes
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

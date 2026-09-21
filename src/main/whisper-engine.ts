import { spawn, type ChildProcess } from 'node:child_process'
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
 * The child's lifecycle is the part that cannot be left to whisper.cpp. A load takes an
 * `AbortSignal` because the caller's stall guard only abandons a promise: without one, a load that
 * outlived its deadline - or a quit during one - would leave a 1.6 GB native process running with
 * nothing left holding a handle to it, and Windows does not reap children on parent exit. Past
 * readiness the returned engine owns the child, reports `alive()` so a crash is released rather
 * than pinned, and ends it with `close()`.
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
  /** Abandons the load: the child is killed and the readiness poll stops. */
  signal?: AbortSignal
  /** Injectable for tests: how long to wait between readiness polls. */
  pollIntervalMs?: number
  /** Injectable for tests: how the helper is started. Production never passes one. */
  spawnServer?: SpawnWhisperServer
}

/**
 * Starts the helper and hands back its process. Only tests supply one, and only so they can stand
 * a real child in for the binary; any launcher must apply `hiddenProcessOptions`.
 */
export type SpawnWhisperServer = (command: string, args: readonly string[]) => ChildProcess

export async function loadWhisperEngine(options: WhisperEngineOptions): Promise<VoiceEngine> {
  const pollIntervalMs = options.pollIntervalMs ?? 250
  const signal = options.signal
  signal?.throwIfAborted()
  const port = await freePort()
  signal?.throwIfAborted()
  const child = (options.spawnServer ?? spawnWhisperServer)(options.serverPath, [
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
  ])
  let exited = false
  let unreachable = false
  let startFailure: Error | null = null
  child.on('exit', (code) => {
    exited = true
    options.log(`whisper-server exited with code ${code ?? 'unknown'}.`)
  })
  // A spawn that never happened - a quarantined or deleted exe - arrives here and nowhere else, so
  // the reason is kept rather than flattened into "exited while loading".
  child.on('error', (cause: Error) => {
    exited = true
    startFailure = cause
    options.log(`whisper-server could not start: ${cause.message}`)
  })
  // The abandoning caller is gone by the time this fires, so the kill has to be wired here.
  const killOnAbort = (): void => {
    child.kill()
  }
  signal?.addEventListener('abort', killOnAbort, { once: true })

  const base = `http://127.0.0.1:${port}`
  let ready = false
  try {
    // Readiness is the server answering /health, which it only does once the model is loaded. The
    // caller bounds this wait with its own stall guard; what is handled here is the child dying,
    // which must reject rather than poll a corpse until the guard fires.
    for (;;) {
      signal?.throwIfAborted()
      if (exited) throw startError(startFailure)
      try {
        const response = await fetch(`${base}/health`, { signal: pollSignal(signal) })
        if (response.ok) break
      } catch {
        // Not listening yet.
      }
      await sleep(pollIntervalMs, signal)
    }
    // An abort that landed while the last probe was in flight still means abandoned: handing back
    // an engine whose child was just killed would give the caller a corpse it thinks it loaded.
    signal?.throwIfAborted()
    ready = true
  } finally {
    // Past readiness the engine object owns the child, and `close()` is what ends it.
    signal?.removeEventListener('abort', killOnAbort)
    if (!ready) child.kill()
  }

  return {
    // A decode that could not reach the port counts as dead: the exit event has not necessarily
    // been delivered yet, and the policy has to release the engine on that failure, not the next.
    alive: () => !exited && !unreachable,
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
      let response: Response
      try {
        response = await fetch(`${base}/inference`, {
          method: 'POST',
          body: form,
          signal: AbortSignal.timeout(DECODE_TIMEOUT_MS)
        })
      } catch (cause) {
        // The only peer on this port is our own child, so a connection that fails or a decode that
        // runs past the deadline is the helper being gone or wedged - not a network to retry.
        unreachable = true
        throw new Error(`The speech engine stopped responding: ${describe(cause)}.`, { cause })
      }
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

/** The only launcher in production: stdio ignored, and the hidden-window policy applied last. */
function spawnWhisperServer(command: string, args: readonly string[]): ChildProcess {
  // stdio ignored: the server logs every request to stderr, and a pipe nobody drains would fill
  // its buffer and wedge the child mid-dictation.
  return spawn(command, [...args], hiddenProcessOptions({ stdio: 'ignore' as const }))
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function startError(failure: Error | null): Error {
  return new Error(
    failure
      ? `The speech engine could not start: ${failure.message}`
      : 'The speech engine exited while loading its model.'
  )
}

/** The readiness probe's own deadline, cut short when the whole load is abandoned. */
function pollSignal(signal: AbortSignal | undefined): AbortSignal {
  const deadline = AbortSignal.timeout(5_000)
  return signal ? AbortSignal.any([deadline, signal]) : deadline
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
 * @internal exported for tests
 */
export function whisperAudioContext(sampleCount: number): number {
  if (sampleCount >= FULL_WINDOW_SAMPLES) return FULL_AUDIO_CONTEXT
  const proportional = Math.ceil((sampleCount / FULL_WINDOW_SAMPLES) * FULL_AUDIO_CONTEXT)
  return Math.min(FULL_AUDIO_CONTEXT, Math.max(256, proportional + 128))
}

/**
 * A port the OS just proved free. Nothing retries the tiny race until the child binds it: losing
 * it reads as the child exiting during the load, and the next request starts over on a fresh port.
 */
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

/**
 * A minimal 16 kHz mono 16-bit PCM WAV around the samples; whisper-server reads nothing else raw.
 * @internal exported for tests
 */
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

/** Sleeps, but never past an abandoned load: a poll interval is dead time the caller is waiting on. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    let timer: NodeJS.Timeout
    const done = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    timer = setTimeout(done, ms)
    signal?.addEventListener('abort', done, { once: true })
  })
}

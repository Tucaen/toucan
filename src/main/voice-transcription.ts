import type { RemoteTranscriptionResult } from '../shared/remote-voice'
import { REMOTE_VOICE_SAMPLE_RATE } from '../shared/remote-voice'
import { withStallGuard } from '../shared/stall-guard'

/**
 * The policy around the speech engine, for every recording that reaches main: the desktop
 * composer's dictation over IPC, and a phone that cannot transcribe itself over
 * `POST /api/transcribe`.
 *
 * The engine is one whisper-server child with a 1.6 GB checkpoint loaded (`whisper-engine.ts`
 * decides *how*; this module decides *when*):
 *
 * - **Lazy and shared.** The model is not loaded for a feature nobody may use; the first request
 *   pays for it and every concurrent one waits on the same load.
 * - **Serialized.** One helper process decodes one utterance at a time; two dictations at once
 *   queue, and a queue of dictations is short by construction.
 * - **A failed load is not fatal.** It is reported to whoever was waiting and the next request
 *   tries again, so a model that finishes downloading after the first attempt just works.
 * - **Released when idle.** A gigabyte and a half is not kept resident for a machine that dictated
 *   once this morning.
 * - **Never orphaned.** Giving up on a load - the deadline, or a quit - aborts it, because the
 *   stall guard only abandons a promise while the helper process keeps loading; and an engine
 *   whose process died is released rather than left pinned as "the engine".
 */
export interface VoiceTranscribeRequest {
  /** Text to bias the decoder towards: the dictation context. Whisper's `initial_prompt`. */
  prompt?: string
  /** ISO 639-1 code, defaulting to auto-detection - both surfaces are multilingual now. */
  language?: string
}

export interface VoiceEngine {
  /** Transcribes one complete mono recording and returns its text, empty for silence. */
  transcribe(audio: Float32Array, sampleRate: number, request?: VoiceTranscribeRequest): Promise<string>
  /** Whether the engine can still decode. False once its helper process is gone. */
  alive(): boolean
  close(): void
}

export interface VoiceTranscriber {
  /** Never rejects: every failure is an `ok: false` verdict the caller can show. */
  transcribe(audio: Float32Array, request?: VoiceTranscribeRequest): Promise<RemoteTranscriptionResult>
  loaded(): boolean
  shutdown(): void
}

export interface VoiceTranscriberOptions {
  /**
   * Loads the engine. The signal is aborted when the load is given up on - the deadline below, or
   * a shutdown - and the loader must take that as far as whatever it has already started.
   */
  loadEngine(signal: AbortSignal): Promise<VoiceEngine>
  /** How long a load may take before it is given up on. Reading 1.6 GB from a slow disk is slow. */
  loadTimeoutMs?: number
  /** How long the model stays resident after its last use. */
  idleUnloadMs?: number
  /** Injectable so tests do not wait in real time. */
  schedule?: (run: () => void, delayMs: number) => { cancel(): void }
}

const DEFAULT_LOAD_TIMEOUT_MS = 120_000
const DEFAULT_IDLE_UNLOAD_MS = 10 * 60_000

const LOAD_TIMEOUT_MESSAGE = 'The desktop timed out while loading its speech model.'
const SHUTDOWN_MESSAGE = 'The desktop is shutting down.'

export function createVoiceTranscriber(options: VoiceTranscriberOptions): VoiceTranscriber {
  const loadTimeoutMs = options.loadTimeoutMs ?? DEFAULT_LOAD_TIMEOUT_MS
  const idleUnloadMs = options.idleUnloadMs ?? DEFAULT_IDLE_UNLOAD_MS
  const schedule =
    options.schedule ??
    ((run, delayMs) => {
      const timer = setTimeout(run, delayMs)
      return { cancel: () => clearTimeout(timer) }
    })

  let engine: VoiceEngine | null = null
  // One fact, not two: a load in flight is its promise and the handle that abandons it.
  let load: { engine: Promise<VoiceEngine>; abandon: AbortController } | null = null
  let idleTimer: { cancel(): void } | null = null
  let shutDown = false
  // The tail of the queue; each request chains onto it so the engine sees one at a time.
  let queue: Promise<unknown> = Promise.resolve()

  const release = (): void => {
    idleTimer?.cancel()
    idleTimer = null
    engine?.close()
    engine = null
  }

  const armIdleRelease = (): void => {
    idleTimer?.cancel()
    idleTimer = schedule(() => {
      idleTimer = null
      release()
    }, idleUnloadMs)
  }

  const ensureEngine = (): Promise<VoiceEngine> => {
    if (engine) return Promise.resolve(engine)
    if (!load) {
      const abandon = new AbortController()
      const loading = withStallGuard(options.loadEngine(abandon.signal), loadTimeoutMs, LOAD_TIMEOUT_MESSAGE).then(
        (loaded) => {
          load = null
          // A shutdown that raced the load owns the engine now, so it is closed rather than kept.
          if (shutDown) {
            loaded.close()
            throw new Error(SHUTDOWN_MESSAGE)
          }
          engine = loaded
          return loaded
        },
        (cause: unknown) => {
          load = null
          // The guard abandons this promise the moment the deadline passes; the signal is what
          // still reaches the helper the loader started, so it is aborted with the same reason.
          abandon.abort(cause)
          throw cause
        }
      )
      load = { engine: loading, abandon }
    }
    return load.engine
  }

  const run = async (audio: Float32Array, request?: VoiceTranscribeRequest): Promise<RemoteTranscriptionResult> => {
    if (shutDown) return { ok: false, message: SHUTDOWN_MESSAGE }
    idleTimer?.cancel()
    idleTimer = null
    let loaded: VoiceEngine
    try {
      loaded = await ensureEngine()
    } catch (cause) {
      return { ok: false, message: `The desktop could not load its speech model: ${describe(cause)}` }
    }
    try {
      const text = (await loaded.transcribe(audio, REMOTE_VOICE_SAMPLE_RATE, request)).trim()
      return { ok: true, text }
    } catch (cause) {
      // A helper whose process died must not stay pinned as "the engine": every later dictation
      // would fail the same way, and each failure would re-arm the idle release on a corpse.
      if (engine === loaded && !loaded.alive()) release()
      return { ok: false, message: `The desktop could not transcribe the recording: ${describe(cause)}` }
    } finally {
      if (!shutDown && engine) armIdleRelease()
    }
  }

  return {
    transcribe(audio, request): Promise<RemoteTranscriptionResult> {
      const next = queue.then(() => run(audio, request))
      // The chain must never reject, or every later request would inherit the rejection.
      queue = next.catch(() => undefined)
      return next
    },
    loaded: () => engine !== null,
    shutdown(): void {
      shutDown = true
      load?.abandon.abort(new Error(SHUTDOWN_MESSAGE))
      release()
    }
  }
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

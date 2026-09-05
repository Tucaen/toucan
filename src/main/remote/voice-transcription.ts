import type { RemoteTranscriptionResult } from '../../shared/remote-voice'
import { REMOTE_VOICE_SAMPLE_RATE } from '../../shared/remote-voice'
import { withStallGuard } from '../../shared/stall-guard'

/**
 * Transcription for a phone that cannot transcribe itself.
 *
 * The desktop's speech model is a renderer concern for the desktop's own microphone, but a phone's
 * recording arrives over HTTP into the main process, and round-tripping it through a window would
 * make dictation depend on a window being open. So main loads the same model files itself - the
 * WASM runs under Node as it does in Chromium - and this module is the policy around that engine:
 *
 * - **Lazy and shared.** A 300 MB model is not loaded for a feature nobody may use; the first
 *   request pays for it and every concurrent one waits on the same load.
 * - **Serialized.** The engine is one native object; two transcriptions at once would interleave
 *   inside it. Requests queue, and a queue of dictations is short by construction.
 * - **A failed load is not fatal.** It is reported to whoever was waiting and the next request
 *   tries again, so a model that finishes downloading after the first attempt just works.
 * - **Released when idle.** Hundreds of megabytes are not kept resident for a phone that dictated
 *   once this morning.
 *
 * The engine is injected. This file decides *when*; `voice-engine.ts` decides *how*.
 */
export interface VoiceEngine {
  /** Transcribes one complete mono recording and returns its text, empty for silence. */
  transcribe(audio: Float32Array, sampleRate: number): string
  close(): void
}

export interface RemoteVoiceTranscriber {
  /** Never rejects: every failure is an `ok: false` verdict the phone can show. */
  transcribe(audio: Float32Array): Promise<RemoteTranscriptionResult>
  loaded(): boolean
  shutdown(): void
}

export interface RemoteVoiceTranscriberOptions {
  loadEngine(): Promise<VoiceEngine>
  /** How long a load may take before it is given up on. Reading 300 MB from a slow disk is slow. */
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

export function createRemoteVoiceTranscriber(options: RemoteVoiceTranscriberOptions): RemoteVoiceTranscriber {
  const loadTimeoutMs = options.loadTimeoutMs ?? DEFAULT_LOAD_TIMEOUT_MS
  const idleUnloadMs = options.idleUnloadMs ?? DEFAULT_IDLE_UNLOAD_MS
  const schedule =
    options.schedule ??
    ((run, delayMs) => {
      const timer = setTimeout(run, delayMs)
      return { cancel: () => clearTimeout(timer) }
    })

  let engine: VoiceEngine | null = null
  let loading: Promise<VoiceEngine> | null = null
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
    if (!loading) {
      loading = withStallGuard(options.loadEngine(), loadTimeoutMs, LOAD_TIMEOUT_MESSAGE).then(
        (loaded) => {
          loading = null
          // A shutdown that raced the load owns the engine now, so it is closed rather than kept.
          if (shutDown) {
            loaded.close()
            throw new Error(SHUTDOWN_MESSAGE)
          }
          engine = loaded
          return loaded
        },
        (cause: unknown) => {
          loading = null
          throw cause
        }
      )
    }
    return loading
  }

  const run = async (audio: Float32Array): Promise<RemoteTranscriptionResult> => {
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
      const text = loaded.transcribe(audio, REMOTE_VOICE_SAMPLE_RATE).trim()
      return { ok: true, text }
    } catch (cause) {
      return { ok: false, message: `The desktop could not transcribe the recording: ${describe(cause)}` }
    } finally {
      if (!shutDown && engine) armIdleRelease()
    }
  }

  return {
    transcribe(audio): Promise<RemoteTranscriptionResult> {
      const next = queue.then(() => run(audio))
      // The chain must never reject, or every later request would inherit the rejection.
      queue = next.catch(() => undefined)
      return next
    },
    loaded: () => engine !== null,
    shutdown(): void {
      shutDown = true
      release()
    }
  }
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

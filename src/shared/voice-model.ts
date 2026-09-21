import type { RemoteTranscriptionResult } from './remote-voice'

/**
 * What "the desktop has its speech model" means, for the host that fetches it and the UI that
 * waits on it - and the seam a finished recording crosses to become text.
 *
 * The engine and its checkpoint are not in the installer (1.6 GB that never changes between
 * releases; see `shared/whisper-assets.ts` for the pins). The host fetches both the first time
 * dictation is asked for, into its own data directory. Nothing here says *how* - that is the
 * host's - only which states a fetch passes through, so the microphone button can say
 * "downloading" with a real percentage instead of "preparing" for four minutes.
 */

export type VoiceModelStatus =
  /** Nothing is on disk and nothing is in flight. */
  | { phase: 'missing' }
  | { phase: 'downloading'; receivedBytes: number; totalBytes: number }
  | { phase: 'ready' }
  | { phase: 'error'; message: string }

/** The seam as the renderer sees it. `ensure` never rejects: a failed download is a status. */
export interface VoiceModelApi {
  state(): Promise<VoiceModelStatus>
  /** Fetches the engine and model if they are not on disk yet; resolves with the settled status. */
  ensure(): Promise<VoiceModelStatus>
  onChange(callback: (status: VoiceModelStatus) => void): () => void
  /**
   * Transcribes one finished recording - 16 kHz mono 16-bit PCM, the same shape a phone posts to
   * `/api/transcribe` - in the main process, where the engine lives. `context` is the dictation
   * context the decoder is biased towards. Never rejects: a failure is an `ok: false` verdict.
   */
  transcribe(pcm: Uint8Array, context: string): Promise<RemoteTranscriptionResult>
}

/** A `0..1` fraction for a progress display; zero before the total is known. */
export function voiceModelProgress(status: VoiceModelStatus): number {
  if (status.phase !== 'downloading' || status.totalBytes <= 0) return 0
  return Math.min(1, status.receivedBytes / status.totalBytes)
}

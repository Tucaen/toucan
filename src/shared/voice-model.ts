/**
 * What "the desktop has its speech model" means, for the host that fetches it and the UI that
 * waits on it.
 *
 * The model is not in the installer. It is 291 MB that never changes between releases, and
 * shipping it inside every installer and every auto-update download cost more than it was worth;
 * the host fetches it from Moonshine's CDN the first time dictation is asked for, into its own
 * data directory, and serves it to the renderer from there. Nothing here says *how* - that is the
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
  /** Fetches the model if it is not on disk yet and resolves with the status that settled on. */
  ensure(): Promise<VoiceModelStatus>
  onChange(callback: (status: VoiceModelStatus) => void): () => void
}

/** A `0..1` fraction for a progress display; zero before the total is known. */
export function voiceModelProgress(status: VoiceModelStatus): number {
  if (status.phase !== 'downloading' || status.totalBytes <= 0) return 0
  return Math.min(1, status.receivedBytes / status.totalBytes)
}

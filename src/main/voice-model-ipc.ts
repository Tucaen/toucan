import type { WebContents } from 'electron'
import type { VoiceModelStatus } from '../shared/voice-model'
import { decodePcm16, remoteVoiceBodyProblem } from '../shared/remote-voice'
import type { IpcRegistrar } from './ipc-registrar'
import type { VoiceModelStore } from './voice-model-store'
import type { VoiceTranscriber } from './voice-transcription'
import { VOICE_MODEL_CHANNELS } from '../shared/ipc-channels'

/**
 * The speech seam, seen from the renderer: what state the model is in, "make it exist", and
 * "turn this recording into text". The host stays the authority - the renderer cannot fetch
 * 1.6 GB into userData itself, and the engine is a main-process child - so the renderer only ever
 * hands over the finished PCM and gets a verdict back, the same contract a phone gets over
 * `POST /api/transcribe`, bounds included.
 */
export function registerVoiceModelIpc(
  ipc: IpcRegistrar,
  store: VoiceModelStore,
  transcriber: Pick<VoiceTranscriber, 'transcribe'>
): void {
  ipc.handle(VOICE_MODEL_CHANNELS.state, () => store.snapshot())
  ipc.handle(VOICE_MODEL_CHANNELS.ensure, () => store.ensure())
  ipc.handle(VOICE_MODEL_CHANNELS.transcribe, async (_event, pcm: unknown, context: unknown) => {
    const bytes = pcm instanceof Uint8Array ? pcm : new Uint8Array(0)
    const problem = remoteVoiceBodyProblem(bytes.byteLength)
    if (problem) return { ok: false as const, message: problem }
    return transcriber.transcribe(decodePcm16(bytes), {
      prompt: typeof context === 'string' ? context : undefined
    })
  })
}

/** Progress arrives for minutes after the click, so the window subscribes for as long as it exists. */
export function forwardVoiceModelChanges(store: VoiceModelStore, contents: WebContents): () => void {
  return store.onChange((status: VoiceModelStatus) => {
    if (!contents.isDestroyed()) contents.send(VOICE_MODEL_CHANNELS.changed, status)
  })
}

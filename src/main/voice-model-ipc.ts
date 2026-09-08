import type { WebContents } from 'electron'
import type { VoiceModelStatus } from '../shared/voice-model'
import type { IpcRegistrar } from './ipc-registrar'
import type { VoiceModelStore } from './voice-model-store'
import { VOICE_MODEL_CHANNELS } from '../shared/ipc-channels'

/**
 * The speech-model seam, seen from the renderer: what state it is in, and "make it exist". The
 * host stays the authority - the renderer cannot fetch 291 MB into userData itself, and it should
 * not know where userData is.
 */
export function registerVoiceModelIpc(ipc: IpcRegistrar, store: VoiceModelStore): void {
  ipc.handle(VOICE_MODEL_CHANNELS.state, () => store.snapshot())
  ipc.handle(VOICE_MODEL_CHANNELS.ensure, () => store.ensure())
}

/** Progress arrives for minutes after the click, so the window subscribes for as long as it exists. */
export function forwardVoiceModelChanges(store: VoiceModelStore, contents: WebContents): () => void {
  return store.onChange((status: VoiceModelStatus) => {
    if (!contents.isDestroyed()) contents.send(VOICE_MODEL_CHANNELS.changed, status)
  })
}

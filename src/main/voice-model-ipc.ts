import type { WebContents } from 'electron'
import type { VoiceModelStatus } from '../shared/voice-model'
import type { IpcRegistrar } from './ipc-registrar'
import type { VoiceModelStore } from './voice-model-store'

/**
 * The speech-model seam, seen from the renderer: what state it is in, and "make it exist". The
 * host stays the authority - the renderer cannot fetch 291 MB into userData itself, and it should
 * not know where userData is.
 */
export function registerVoiceModelIpc(ipc: IpcRegistrar, store: VoiceModelStore): void {
  ipc.handle('voice-model:state', () => store.snapshot())
  ipc.handle('voice-model:ensure', () => store.ensure())
}

/** Progress arrives for minutes after the click, so the window subscribes for as long as it exists. */
export function forwardVoiceModelChanges(store: VoiceModelStore, contents: WebContents): () => void {
  return store.onChange((status: VoiceModelStatus) => {
    if (!contents.isDestroyed()) contents.send('voice-model:changed', status)
  })
}

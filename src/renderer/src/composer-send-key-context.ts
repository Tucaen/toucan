import { createContext, useContext } from 'react'
import { COMPOSER_SEND_KEY_DEFAULT, type ComposerSendKey } from './composer-keys'

export interface ComposerSendKeyPreference {
  sendKey: ComposerSendKey
  setSendKey(next: ComposerSendKey): void
}

/**
 * The send-key preference is workspace-wide, so it reaches every composer through context rather
 * than being copied into each node's data - changing it in one node must change it in all of
 * them, and no node owns it.
 */
export const ComposerSendKeyContext = createContext<ComposerSendKeyPreference>({
  sendKey: COMPOSER_SEND_KEY_DEFAULT,
  setSendKey: () => {}
})

export function useComposerSendKey(): ComposerSendKeyPreference {
  return useContext(ComposerSendKeyContext)
}

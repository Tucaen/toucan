import { createContext, useContext } from 'react'
import type { DictationCleanupPreference } from '../../shared/dictation-cleanup'

export const DictationCleanupContext = createContext<{
  preference: DictationCleanupPreference
  setPreference(preference: DictationCleanupPreference): void
}>({ preference: { enabled: false }, setPreference: () => {} })

export function useDictationCleanupPreference(): React.ContextType<typeof DictationCleanupContext> {
  return useContext(DictationCleanupContext)
}

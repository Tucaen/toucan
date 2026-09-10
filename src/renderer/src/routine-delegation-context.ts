import { createContext, useContext } from 'react'
import type { RoutineDelegationPreference } from '../../shared/routine-delegation'

export interface RoutineDelegationSetting {
  preference: RoutineDelegationPreference
  setPreference(next: RoutineDelegationPreference): void
}

/**
 * "Delegate routine work cheaply" is workspace-wide, like the composer send key: it reaches every
 * chat node through context rather than node data, because changing it in one node changes what
 * every *newly created or resumed* Codex session is launched with. What a live session actually
 * runs under is separate state (`AgentTranscriptState.routineDelegation`, reported by main from
 * the launch itself) - the preference here is only the request.
 */
export const RoutineDelegationContext = createContext<RoutineDelegationSetting>({
  preference: { enabled: false },
  setPreference: () => {}
})

export function useRoutineDelegation(): RoutineDelegationSetting {
  return useContext(RoutineDelegationContext)
}

import { createContext, useContext } from 'react'
import type { DecisionDelegationPreference } from '../../shared/decision-delegation'

export interface DecisionDelegationSetting {
  preference: DecisionDelegationPreference
  setPreference(next: DecisionDelegationPreference): void
  /**
   * Whether the decision provider's skill is installed, as last probed - `undefined` until the
   * first probe answers. Workspace-wide, like the preference: the answer is a property of this
   * machine, not of a node.
   */
  skillInstalled: boolean | undefined
  /**
   * Re-runs the probe. Called when a decisions picker opens, which is the only moment a stale
   * answer is about to be shown to someone - there is no watcher, and none is wanted for a file
   * that changes when the user installs a plugin.
   */
  refreshAvailability(): void
}

/**
 * "Delegate decisions" is workspace-wide for the same reason routine delegation is: changing it in
 * one node changes what every *newly created or resumed* session is launched with. What a live
 * session actually carries is separate state (`AgentTranscriptState.decisionDelegation`, reported
 * by main from the launch itself) - the preference here is only the request.
 */
export const DecisionDelegationContext = createContext<DecisionDelegationSetting>({
  preference: { enabled: false },
  setPreference: () => {},
  skillInstalled: undefined,
  refreshAvailability: () => {}
})

export function useDecisionDelegation(): DecisionDelegationSetting {
  return useContext(DecisionDelegationContext)
}

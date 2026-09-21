import {
  DECISION_PROVIDER_INSTALL_HINT,
  type AgentDecisionDelegation,
  type DecisionDelegationPreference
} from '../../shared/decision-delegation'

export const DECISION_DELEGATION_OFF_OPTION = {
  id: 'off',
  name: 'Off',
  description: 'Every choice, score and classification is made by the main model itself'
} as const

export const DECISION_DELEGATION_ON_OPTION = {
  id: 'on',
  name: 'On',
  description:
    'Decision-shaped subtasks - choose, score, route, classify - may go to the installed decision-provider skill; work that produces or edits files stays where it is'
} as const

export interface DecisionDelegationDisplay {
  options: { id: string; name: string; description: string; disabled?: boolean }[]
  selectedId: string
  /** Per-session status beside the picker; absent when the preference and the session agree. */
  note?: string
}

/**
 * The decisions picker's options and status note for one node. Mirrors
 * `routine-delegation-display.ts`, and for the same reason: the preference is workspace-wide, but
 * the policy is fixed at session creation or resume, so the note is the honesty layer that reports
 * a disagreement between what is selected and what the running session actually launched with.
 *
 * The trigger itself is never closed - opening the menu is what re-runs the availability probe,
 * so a picker that refused to open could never learn about a skill installed since launch. Only
 * the "On" option inside is disabled when the skill is absent, and it says how to get it. A Codex
 * node still offers the toggle (the preference is workspace-wide) and its note says the carriage
 * is Claude-only for now.
 */
export function describeDecisionDelegation(
  preference: DecisionDelegationPreference,
  applied: AgentDecisionDelegation | null | undefined,
  skillInstalled: boolean | undefined
): DecisionDelegationDisplay {
  const options = [
    DECISION_DELEGATION_OFF_OPTION,
    // `undefined` is "not probed yet" rather than "absent": the option stays open, because the
    // launch-time probe - not this one - decides what a session carries.
    skillInstalled === false
      ? { ...DECISION_DELEGATION_ON_OPTION, description: DECISION_PROVIDER_INSTALL_HINT, disabled: true }
      : DECISION_DELEGATION_ON_OPTION
  ]
  const selectedId = preference.enabled ? DECISION_DELEGATION_ON_OPTION.id : DECISION_DELEGATION_OFF_OPTION.id
  if (applied?.status === 'unavailable') return { options, selectedId, note: applied.message }
  const configured = applied?.status === 'configured'
  if (preference.enabled && !configured)
    return { options, selectedId, note: 'Applies when this conversation next starts or resumes' }
  if (!preference.enabled && configured)
    return { options, selectedId, note: 'Still delegating decisions until this conversation restarts' }
  return { options, selectedId }
}

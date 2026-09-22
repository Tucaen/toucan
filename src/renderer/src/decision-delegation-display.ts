import {
  DECISION_PROVIDER_INSTALL_HINT,
  type AgentDecisionDelegation,
  type DecisionDelegationPreference
} from '../../shared/decision-delegation'
import { launchPolicyNote, type LaunchedDelegation } from '../../shared/launch-policy-note'

/** @internal exported for tests */
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
 * The decisions picker's options and status note for one node. The note itself comes from
 * `launchPolicyNote`, which every delegation picker shares: the preference is workspace-wide, but
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
  const launched: LaunchedDelegation =
    applied?.status === 'unavailable'
      ? { status: 'unavailable', message: applied.message }
      : applied?.status === 'configured'
        ? // An on/off policy matches whenever the session is delegating at all: there is no second
          // shape of "on" it could have launched with.
          { status: 'delegating', matchesSelection: true }
        : { status: 'off' }
  return { options, selectedId, note: launchPolicyNote(preference.enabled, launched, 'decisions') }
}

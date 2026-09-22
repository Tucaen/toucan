import type { AgentProvider } from '../../shared/agent'
import { launchPolicyNote, type LaunchedDelegation } from '../../shared/launch-policy-note'
import {
  WORKER_MODELS,
  workerFromPreference,
  type AgentRoutineDelegation,
  type RoutineDelegationPreference
} from '../../shared/routine-delegation'

export const DELEGATION_OFF_OPTION = {
  id: 'off',
  name: 'Main model only',
  description: 'No automatic delegation; every task runs on the selected main model'
} as const

export interface RoutineDelegationDisplay {
  options: { id: string; name: string; description: string }[]
  selectedId: string
  /** Per-session status beside the picker; absent when the preference and the session agree. */
  note?: string
}

/**
 * The delegation picker's options and status note for one provider's node. The preference is
 * workspace-wide but the worker list and the note are per provider and per session: the policy is
 * fixed at session creation or resume, so a session launched before the preference changed keeps
 * its launch-time policy until it is recreated or resumed. The note only ever reports a
 * disagreement, in the wording `launchPolicyNote` gives every delegation picker - the option's own
 * wording ("may run on") already carries that a worker is requested, never enforced. Both
 * providers share this one contract.
 */
export function describeRoutineDelegation(
  provider: AgentProvider,
  preference: RoutineDelegationPreference,
  applied: AgentRoutineDelegation | null | undefined
): RoutineDelegationDisplay {
  const options = [
    DELEGATION_OFF_OPTION,
    ...WORKER_MODELS[provider].map((model) => ({
      id: model.id,
      name: model.name,
      description: `Bounded searches, extraction, prescribed checks and recipe-driven mechanical edits may run on ${model.name}${
        model.effortId ? ` (${model.effortId} reasoning)` : ''
      }; planning, diagnosis and review stay on the main model`
    }))
  ]
  const selectedId = preference.enabled ? workerFromPreference(provider, preference).id : DELEGATION_OFF_OPTION.id
  const launched: LaunchedDelegation =
    applied?.status === 'unavailable'
      ? { status: 'unavailable', message: applied.message }
      : applied?.status === 'configured' && applied.workerModelId
        ? { status: 'delegating', matchesSelection: applied.workerModelId === selectedId }
        : { status: 'off' }
  return { options, selectedId, note: launchPolicyNote(preference.enabled, launched) }
}

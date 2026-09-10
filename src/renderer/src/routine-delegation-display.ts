import type { AgentProvider } from '../../shared/agent'
import {
  ROUTINE_WORK_SUMMARY,
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
 * its launch-time policy until it is recreated or resumed - and a configured worker is only ever
 * *requested*; nothing here may claim it is enforced. Both providers share this one contract.
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
  if (applied?.status === 'unavailable') return { options, selectedId, note: applied.message }
  const appliedModelId = applied?.status === 'configured' ? applied.workerModelId : undefined
  if (preference.enabled && appliedModelId !== selectedId)
    return { options, selectedId, note: 'Applies when this conversation next starts or resumes' }
  if (!preference.enabled && appliedModelId)
    return { options, selectedId, note: 'Still delegating until this conversation restarts' }
  if (appliedModelId) return { options, selectedId, note: 'Worker model requested, not provider-confirmed' }
  return { options, selectedId }
}

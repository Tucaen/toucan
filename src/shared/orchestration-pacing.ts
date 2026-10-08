import type { ProviderUsageEntry } from './agent'

/** The action an orchestration pacing recommendation currently advises on. */
export type OrchestrationPacingAction = 'spawn'

/** Whether the decision can rely on the provider reading it was given. */
export type OrchestrationUsageFreshness = 'fresh' | 'stale' | 'unavailable'

/** The advisory state for one provider-wide orchestration decision. */
export type OrchestrationPacingState = 'unrestricted' | 'drain' | 'pause'

/**
 * One provider-neutral, advisory answer for an orchestration action. `drain` leaves the remaining
 * window for existing ticket work to reach review or merge; `pause` advises waiting for reset.
 * Neither state stops already-running work or changes what the endpoint will accept in shadow mode.
 */
export interface OrchestrationPacingRecommendation {
  action: OrchestrationPacingAction
  state: OrchestrationPacingState
  freshness: OrchestrationUsageFreshness
  activeTicketSessions: number
  /** The five-hour reset that releases a pause, when the provider reported one. */
  resetsAt?: number
}

/** Inputs available at the endpoint, deliberately independent of any particular provider. */
export interface OrchestrationPacingInput {
  action: OrchestrationPacingAction
  usage: ProviderUsageEntry | null
  freshness: OrchestrationUsageFreshness
  now: number
  /** Live orchestrated ticket sessions for this provider, across every workspace project. */
  activeTicketSessions: number
}

/**
 * The one policy seam for the shadow curve and its conservative reserve. The reserve applies only
 * when usage cannot be trusted: one ticket may continue or start, while further work drains.
 */
export interface OrchestrationPacingPolicy {
  fiveHour: {
    drainAtPercent: number
    pauseAtPercent: number
  }
  unavailableUsage: {
    maxActiveTicketSessions: number
  }
}

/** @internal exported for tests */
export const DEFAULT_ORCHESTRATION_PACING_POLICY: OrchestrationPacingPolicy = {
  fiveHour: { drainAtPercent: 70, pauseAtPercent: 85 },
  unavailableUsage: { maxActiveTicketSessions: 1 }
}

function activeTickets(input: OrchestrationPacingInput): number {
  return Math.max(0, input.activeTicketSessions)
}

function recommendation(
  input: OrchestrationPacingInput,
  state: OrchestrationPacingState,
  resetsAt?: number
): OrchestrationPacingRecommendation {
  return {
    action: input.action,
    state,
    freshness: input.freshness,
    activeTicketSessions: activeTickets(input),
    ...(resetsAt !== undefined ? { resetsAt } : {})
  }
}

/**
 * Makes the conservative, provider-neutral pacing recommendation. Only the plan-wide five-hour
 * window drives the curve: weekly and model windows remain visible in `usage`, but never turn
 * into guessed token budgets or a more aggressive recommendation.
 */
export function decideOrchestrationPacing(
  input: OrchestrationPacingInput,
  policy: OrchestrationPacingPolicy = DEFAULT_ORCHESTRATION_PACING_POLICY
): OrchestrationPacingRecommendation {
  const active = activeTickets(input)
  if (input.freshness !== 'fresh' || !input.usage) {
    return recommendation(input, active >= policy.unavailableUsage.maxActiveTicketSessions ? 'drain' : 'unrestricted')
  }

  const fiveHour = input.usage.status.fiveHour
  if (!fiveHour) return recommendation(input, 'unrestricted')
  // A reported reset ends a pause even if a just-expired reading has not been replaced yet.
  if (fiveHour.resetsAt !== undefined && fiveHour.resetsAt <= input.now) return recommendation(input, 'unrestricted')
  if (fiveHour.usedPercent >= policy.fiveHour.pauseAtPercent) return recommendation(input, 'pause', fiveHour.resetsAt)
  if (fiveHour.usedPercent >= policy.fiveHour.drainAtPercent && active > 0) return recommendation(input, 'drain')
  return recommendation(input, 'unrestricted')
}

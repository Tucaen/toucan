import type { ProviderUsageEntry } from './agent'

/** The action an orchestration pacing recommendation currently advises on. */
export type OrchestrationPacingAction = 'spawn'

/** Whether the decision can rely on the provider reading it was given. */
export type OrchestrationUsageFreshness = 'fresh' | 'stale' | 'unavailable'

/** The advisory state for one provider-wide orchestration decision. */
export type OrchestrationPacingState = 'unrestricted' | 'drain' | 'pause'

/** The stable explanation for an advisory pacing state. */
export type OrchestrationPacingReason =
  | 'five_hour_below_drain_threshold'
  | 'five_hour_drain_active_ticket_work'
  | 'five_hour_pause_threshold'
  | 'five_hour_reset_elapsed'
  | 'no_five_hour_window'
  | 'stale_usage_reserve_available'
  | 'stale_usage_reserve_exhausted'
  | 'unavailable_usage_reserve_available'
  | 'unavailable_usage_reserve_exhausted'
  | 'usage_entry_missing'

/** What constrained the recommendation, rather than a provider-specific token estimate. */
export type OrchestrationPacingConstrainingWindow = 'five_hour' | 'usage_freshness' | 'none'

/**
 * One provider-neutral, advisory answer for an orchestration action. `drain` leaves the remaining
 * window for existing ticket work to reach review or merge; `pause` advises waiting for reset.
 * Neither state stops already-running work or changes what the endpoint will accept in shadow mode.
 */
export interface OrchestrationPacingRecommendation {
  action: OrchestrationPacingAction
  state: OrchestrationPacingState
  reason: OrchestrationPacingReason
  constrainingWindow: OrchestrationPacingConstrainingWindow
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
  reason: OrchestrationPacingReason,
  constrainingWindow: OrchestrationPacingConstrainingWindow,
  resetsAt?: number
): OrchestrationPacingRecommendation {
  return {
    action: input.action,
    state,
    reason,
    constrainingWindow,
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
    const exhausted = active >= policy.unavailableUsage.maxActiveTicketSessions
    const reason: OrchestrationPacingReason =
      input.freshness === 'stale'
        ? exhausted
          ? 'stale_usage_reserve_exhausted'
          : 'stale_usage_reserve_available'
        : input.freshness === 'unavailable'
          ? exhausted
            ? 'unavailable_usage_reserve_exhausted'
            : 'unavailable_usage_reserve_available'
          : 'usage_entry_missing'
    return recommendation(input, exhausted ? 'drain' : 'unrestricted', reason, 'usage_freshness')
  }

  const fiveHour = input.usage.status.fiveHour
  if (!fiveHour) return recommendation(input, 'unrestricted', 'no_five_hour_window', 'none')
  // A reported reset ends a pause even if a just-expired reading has not been replaced yet.
  if (fiveHour.resetsAt !== undefined && fiveHour.resetsAt <= input.now) {
    return recommendation(input, 'unrestricted', 'five_hour_reset_elapsed', 'none')
  }
  if (fiveHour.usedPercent >= policy.fiveHour.pauseAtPercent) {
    return recommendation(input, 'pause', 'five_hour_pause_threshold', 'five_hour', fiveHour.resetsAt)
  }
  if (fiveHour.usedPercent >= policy.fiveHour.drainAtPercent && active > 0) {
    return recommendation(input, 'drain', 'five_hour_drain_active_ticket_work', 'five_hour')
  }
  return recommendation(input, 'unrestricted', 'five_hour_below_drain_threshold', 'five_hour')
}

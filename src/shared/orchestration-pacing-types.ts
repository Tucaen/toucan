/** The action an orchestration pacing recommendation currently advises on. */
export type OrchestrationPacingAction = 'spawn'

/** Whether the decision can rely on the provider reading it was given. */
export type OrchestrationUsageFreshness = 'fresh' | 'stale' | 'unavailable'

/** The state for one provider-wide orchestration decision. */
export type OrchestrationPacingState = 'unrestricted' | 'drain' | 'pause'

/** Stable explanations for a pacing state, shared with durable-record validation. */
export const ORCHESTRATION_PACING_REASONS = [
  'five_hour_below_drain_threshold',
  'five_hour_drain_active_ticket_work',
  'five_hour_pause_threshold',
  'five_hour_reset_elapsed',
  'no_five_hour_window',
  'stale_usage_reserve_available',
  'stale_usage_reserve_exhausted',
  'unavailable_usage_reserve_available',
  'unavailable_usage_reserve_exhausted',
  'usage_entry_missing'
] as const
export type OrchestrationPacingReason = (typeof ORCHESTRATION_PACING_REASONS)[number]

/** What constrained the recommendation, rather than a provider-specific token estimate. */
export type OrchestrationPacingConstrainingWindow = 'five_hour' | 'usage_freshness' | 'none'

/**
 * One provider-neutral answer for an orchestration action. `drain` leaves the remaining window for
 * existing ticket work to reach review or merge; `pause` advises waiting for reset. Neither state
 * stops already-running work; the endpoint may enforce it or expose it in shadow mode.
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

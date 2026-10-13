import type { ProviderUsageEntry } from './agent'
import type {
  OrchestrationPacingAction,
  OrchestrationPacingConstrainingWindow,
  OrchestrationPacingRecommendation,
  OrchestrationPacingReason,
  OrchestrationPacingState,
  OrchestrationUsageFreshness
} from './orchestration-pacing-types'

export type {
  OrchestrationPacingAction,
  OrchestrationPacingConstrainingWindow,
  OrchestrationPacingRecommendation,
  OrchestrationPacingReason,
  OrchestrationPacingState,
  OrchestrationUsageFreshness
} from './orchestration-pacing-types'

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
 * The one policy seam for the pacing curve and its conservative reserve. The reserve applies only
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
  if (fiveHour.usedPercent >= policy.fiveHour.pauseAtPercent) {
    return recommendation(input, 'pause', 'five_hour_pause_threshold', 'five_hour', fiveHour.resetsAt)
  }
  if (fiveHour.usedPercent >= policy.fiveHour.drainAtPercent && active > 0) {
    return recommendation(input, 'drain', 'five_hour_drain_active_ticket_work', 'five_hour')
  }
  return recommendation(input, 'unrestricted', 'five_hour_below_drain_threshold', 'five_hour')
}

/** One fresh five-hour reading, kept by the usage cache for the burn rate. */
export interface UsageSample {
  at: number
  usedPercent: number
}

/** Live sessions of one provider that are mid-turn right now, across every project. */
export interface WorkingSessions {
  tickets: number
  orchestrators: number
  chats: number
}

/**
 * What an orchestrator weighs before starting a ticket past a pacing deferral: how much of the
 * five-hour window is left, how fast it is being used, and what is using it. Projections are in
 * percent and may exceed 100; null means Toucan cannot say yet.
 */
export interface OrchestrationUsageOutlook {
  usedPercent: number | null
  resetsAt: number | null
  minutesToReset: number | null
  /** Five-hour percent used per minute over the recent window, from Toucan's own readings. */
  burnRatePerMinute: number | null
  /** Usage at the reset if the current pace continues. */
  projectedAtReset: number | null
  /** The same with one more session working at the current per-session pace. */
  projectedWithOneMore: number | null
  working: WorkingSessions
}

/** @internal exported for tests */
export const BURN_RATE_WINDOW_MS = 60 * 60_000
/** @internal exported for tests */
export const BURN_RATE_MIN_SPAN_MS = 5 * 60_000

/**
 * @internal exported for tests
 * The recent pace of the five-hour window in percent per minute, or null without enough history:
 * at least two readings five minutes apart within the last hour. Readings before the latest drop
 * belong to the previous window, so a reset never shows as a negative pace.
 */
export function usageBurnRate(samples: readonly UsageSample[], now: number): number | null {
  const recent = samples.filter((sample) => sample.at <= now && now - sample.at <= BURN_RATE_WINDOW_MS)
  let start = 0
  for (let index = 1; index < recent.length; index += 1) {
    if (recent[index].usedPercent < recent[index - 1].usedPercent) start = index
  }
  const window = recent.slice(start)
  if (window.length < 2) return null
  const first = window[0]
  const last = window[window.length - 1]
  const span = last.at - first.at
  if (span < BURN_RATE_MIN_SPAN_MS) return null
  return Math.max(0, last.usedPercent - first.usedPercent) / (span / 60_000)
}

const round = (value: number): number => Math.round(value * 100) / 100

export function usageOutlook(input: {
  usage: ProviderUsageEntry | null
  samples: readonly UsageSample[]
  working: WorkingSessions
  now: number
}): OrchestrationUsageOutlook {
  const fiveHour = input.usage?.status.fiveHour
  const usedPercent = fiveHour?.usedPercent ?? null
  const resetsAt = fiveHour?.resetsAt ?? null
  const minutesToReset = resetsAt === null ? null : Math.max(0, (resetsAt - input.now) / 60_000)
  const rate = usageBurnRate(input.samples, input.now)
  const sessions = input.working.tickets + input.working.orchestrators + input.working.chats
  const projected =
    usedPercent === null || minutesToReset === null || rate === null ? null : usedPercent + rate * minutesToReset
  const perSession = rate === null ? null : rate / Math.max(1, sessions)
  return {
    usedPercent,
    resetsAt,
    minutesToReset: minutesToReset === null ? null : Math.round(minutesToReset),
    burnRatePerMinute: rate === null ? null : round(rate),
    projectedAtReset: projected === null ? null : round(projected),
    projectedWithOneMore:
      projected === null || perSession === null || minutesToReset === null
        ? null
        : round(projected + perSession * minutesToReset),
    working: input.working
  }
}

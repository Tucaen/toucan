import type { ProviderUsageEntry } from './agent'
import type { AgentProvider } from './agent-provider'
import type { OrchestrationPacingRecommendation } from './orchestration-pacing'

/** The provider-neutral pacing answer attached to an orchestrator's usage response. */
export type OrchestratorUsagePacing = OrchestrationPacingRecommendation

/** Read-only usage result for the live provider of an authenticated orchestrator grant. */
export interface OrchestratorUsageResponse {
  provider: AgentProvider
  /** The normalized last reading, including a stale fallback when one exists. */
  usage: ProviderUsageEntry | null
  /** Why `usage` is absent, or why its entry is stale. */
  state: 'available' | 'missing' | 'failed'
  /** The current spawn recommendation; admission enforcement happens only on `spawn`. */
  pacing: OrchestratorUsagePacing
}

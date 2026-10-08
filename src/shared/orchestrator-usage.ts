import type { ProviderUsageEntry } from './agent'
import type { AgentProvider } from './agent-provider'

/** The recommendation is deliberately explicit until #49 defines actionable pacing. */
export interface OrchestratorUsagePacing {
  state: 'unknown'
}

/** Read-only usage result for the live provider of an authenticated orchestrator grant. */
export interface OrchestratorUsageResponse {
  provider: AgentProvider
  /** The normalized last reading, including a stale fallback when one exists. */
  usage: ProviderUsageEntry | null
  /** Why `usage` is absent, or why its entry is stale. */
  state: 'available' | 'missing' | 'failed'
  /** A machine-readable recommendation placeholder; #49 may add actionable states. */
  pacing: OrchestratorUsagePacing
}

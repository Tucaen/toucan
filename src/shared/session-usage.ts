import type { AgentSessionCost } from './agent'

/** The latest `usage_update` a session reported, verbatim; display maths lives in the renderer. */
export interface SessionUsageInput {
  /** Tokens currently in context, as the adapter last reported them. */
  used?: number
  /** The model's context window; adapters that cannot determine it omit it. */
  size?: number
  cost?: AgentSessionCost
}

/**
 * Folds one `usage_update` onto what the session already knew. Adapters report these fields
 * independently - Claude sends a cost only once a turn has produced tokens, Codex sends none at
 * all, and either may report tokens before it knows the context window - so an update is a patch,
 * not a replacement: overwriting wholesale would blank a cost or a gauge the reader was already
 * shown, which reads as "it went away" rather than "it was not mentioned this time".
 */
export function mergeSessionUsage(previous: SessionUsageInput | null, update: SessionUsageInput): SessionUsageInput {
  return {
    ...previous,
    ...(update.used !== undefined ? { used: update.used } : {}),
    ...(update.size !== undefined ? { size: update.size } : {}),
    ...(update.cost !== undefined ? { cost: update.cost } : {})
  }
}

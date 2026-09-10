import type { AgentActivity } from '../../shared/agent'

/**
 * Wraps a family's recognizer so it answers once per activity object rather than once per call.
 * Every card asks what it is several times in a single render, and the worklog re-renders on
 * every streaming chunk; `mergeActivity` produces a fresh object per update, so the cache turns
 * over on its own. `parse` must never return `undefined` - that is the cache's "not yet asked"
 * marker - which is why every recognizer here returns `T | null`.
 */
export function memoizePerActivity<T>(parse: (activity: AgentActivity) => T): (activity: AgentActivity) => T {
  const cache = new WeakMap<AgentActivity, T>()
  return (activity) => {
    const cached = cache.get(activity)
    if (cached !== undefined) return cached
    const parsed = parse(activity)
    cache.set(activity, parsed)
    return parsed
  }
}

/**
 * The three reads every tool card makes of a tool call's provider-specific arguments. `rawInput`
 * is whatever the adapter forwarded verbatim, so a card that indexes into it without checking is
 * one schema change away from throwing inside a render; these are the checked forms every family
 * parses through (see `file-operation.ts`, `shell-execution.ts`, `mcp-tool-call.ts`).
 */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

export function asText(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

export { normalizeToolName } from '../../shared/tool-identity'

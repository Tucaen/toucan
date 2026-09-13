/**
 * `CODEX_CONFIG` is codex-acp's one session-scoped configuration channel: the adapter parses the
 * variable once at process start and merges it into every `thread/start`/`thread/resume` config,
 * and Toucan launches one adapter process per node - so anything layered here configures that
 * session alone and never touches the user's `~/.codex/config.toml`. Verified on codex-acp 1.10.0
 * (Codex 0.153.4); the keys are Codex TOML config fields.
 *
 * This module owns the layering itself so the several things Toucan configures per session (the
 * routine-delegation policy in `routine-delegation.ts`, the session outcome index pointer) compose
 * rather than overwrite each other, and so a value the user set themselves survives all of them.
 */

/**
 * Layers one config object into an environment's `CODEX_CONFIG`. Nested tables merge key by key,
 * so a caller setting `agents.max_depth` cannot drop a sibling another caller set; scalars are
 * replaced. `developer_instructions` is the exception, and the reason this is not a plain deep
 * merge: it is prose several callers legitimately contribute to, so every contribution is appended
 * to what is already there - the user's own text first, in the order it was layered. An
 * unparseable existing value is replaced, since the adapter's own `JSON.parse` would have refused
 * it anyway.
 */
export function withCodexSessionConfig(
  environment: Record<string, string | undefined>,
  addition: Record<string, unknown>
): Record<string, string | undefined> {
  let existing: Record<string, unknown> = {}
  if (environment.CODEX_CONFIG) {
    try {
      const parsed: unknown = JSON.parse(environment.CODEX_CONFIG)
      if (isRecord(parsed)) existing = parsed
    } catch {
      // Replaced below: codex-acp would crash on it before any session opened.
    }
  }
  const merged = mergeConfig(existing, addition)
  const instruction = appendedInstructions(existing.developer_instructions, addition.developer_instructions)
  if (instruction !== undefined) merged.developer_instructions = instruction
  return { ...environment, CODEX_CONFIG: JSON.stringify(merged) }
}

function appendedInstructions(existing: unknown, addition: unknown): string | undefined {
  if (typeof addition !== 'string' || !addition.trim()) return undefined
  if (typeof existing !== 'string' || !existing.trim()) return addition
  return `${existing}\n\n${addition}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function mergeConfig(base: Record<string, unknown>, addition: Record<string, unknown>): Record<string, unknown> {
  const merged = { ...base }
  for (const [key, value] of Object.entries(addition)) {
    const existing = merged[key]
    merged[key] = isRecord(existing) && isRecord(value) ? mergeConfig(existing, value) : value
  }
  return merged
}

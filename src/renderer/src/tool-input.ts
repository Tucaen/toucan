/**
 * The three reads every tool card makes of a tool call's provider-specific arguments. `rawInput`
 * is whatever the adapter forwarded verbatim, so a card that indexes into it without checking is
 * one schema change away from throwing inside a render; these are the checked forms every family
 * parses through (see `file-operation.ts`, `shell-execution.ts`, `mcp-tool-call.ts`).
 */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

export function asText(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * A tool name flattened to its bare identity, so `BashOutput`, `bash_output` and a namespaced
 * `shell.bash` all agree. Namespace separators are dropped along with the namespace, which is why
 * a card that must *not* claim a third-party tool of the same bare name (an MCP `mcp__x__grep`)
 * has to check the qualified name first - see the family ordering in `tool-card-families.tsx`.
 */
export function normalizeToolName(name: string | undefined): string | undefined {
  if (!name) return undefined
  const bare = name.split(/[.:]|__/).filter(Boolean).at(-1) ?? name
  return bare.toLowerCase().replace(/[^a-z]/g, '')
}

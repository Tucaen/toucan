import type { AgentActivity } from './agent'

/** Bare built-in identity; check the qualified MCP identity before claiming a built-in. */
export function normalizeToolName(name: string | undefined): string | undefined {
  if (!name) return undefined
  const bare =
    name
      .split(/[.:]|__/)
      .filter(Boolean)
      .at(-1) ?? name
  return bare.toLowerCase().replace(/[^a-z]/g, '')
}

export interface McpToolCall {
  server: string
  tool: string
  arguments?: unknown
}

/** The three provider forms of an MCP identity, shared by cards and transcript evidence. */
export function parseMcpToolCall(activity: AgentActivity): McpToolCall | null {
  const named = activity.toolName ? /^mcp__(.+?)__(.+)$/.exec(activity.toolName) : null
  if (named)
    return {
      server: named[1] ?? '',
      tool: named[2] ?? '',
      ...(activity.rawInput !== undefined ? { arguments: activity.rawInput } : {})
    }
  const input =
    activity.rawInput !== null && typeof activity.rawInput === 'object' && !Array.isArray(activity.rawInput)
      ? (activity.rawInput as Record<string, unknown>)
      : undefined
  if (typeof input?.server === 'string' && input.server && typeof input.tool === 'string' && input.tool) {
    return {
      server: input.server,
      tool: input.tool,
      ...(input.arguments !== undefined ? { arguments: input.arguments } : {})
    }
  }
  const titled = activity.title ? /^mcp\.(.+?)\.(.+)$/.exec(activity.title) : null
  if (titled)
    return {
      server: titled[1] ?? '',
      tool: titled[2] ?? '',
      ...(activity.rawInput !== undefined ? { arguments: activity.rawInput } : {})
    }
  return null
}

export function isDelegationActivity(activity: AgentActivity): boolean {
  const name = normalizeToolName(activity.toolName)
  return Boolean(activity.subagent) || ((name === 'task' || name === 'agent') && parseMcpToolCall(activity) === null)
}

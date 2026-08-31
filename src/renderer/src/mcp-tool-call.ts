import type { AgentActivity } from '../../shared/agent'
import { toolOutputLines } from './tool-card'
import { asRecord, asText, memoizePerActivity } from './tool-input'

/**
 * A call into a tool the *user* connected, not one the agent ships with. The two halves are kept
 * apart deliberately: which server answered is the part that says whether this was a built-in or
 * somebody's MCP process, and collapsing it into one `mcp__linear__create_issue` string is what
 * makes a third-party tool read as a built-in.
 */
export interface McpToolCall {
  server: string
  tool: string
  /** The tool's arguments, verbatim - shapes are per-tool and there is nothing generic to read. */
  arguments?: unknown
}

/** claude-agent-acp forwards MCP tools under the CLI's own `mcp__<server>__<tool>` name. */
const CLAUDE_MCP_NAME = /^mcp__(.+?)__(.+)$/

/** codex-acp titles an `mcpToolCall` item `mcp.<server>.<tool>` and carries no tool name at all. */
const CODEX_MCP_TITLE = /^mcp\.(.+?)\.(.+)$/

/**
 * Recognizes an MCP call from whichever of the three things the adapter reported: the qualified
 * tool name (Claude), the structured `{ server, tool }` arguments codex-acp builds, or its
 * `mcp.<server>.<tool>` title. Returns `null` for anything that isn't unambiguously third-party -
 * a card that guesses here would put somebody else's server name on a built-in tool.
 */
export function parseMcpToolCall(activity: AgentActivity): McpToolCall | null {
  const input = asRecord(activity.rawInput)
  const named = activity.toolName ? CLAUDE_MCP_NAME.exec(activity.toolName) : null
  if (named) {
    // Claude's `rawInput` *is* the tool's arguments; it is not a codex-style envelope, so an
    // `arguments` key in it belongs to the third-party tool and must not be unwrapped.
    return {
      server: named[1],
      tool: named[2],
      ...(activity.rawInput !== undefined ? { arguments: activity.rawInput } : {})
    }
  }
  const server = asText(input?.server)
  const tool = asText(input?.tool)
  if (server && tool) {
    return { server, tool, ...(input?.arguments !== undefined ? { arguments: input.arguments } : {}) }
  }
  const titled = activity.title ? CODEX_MCP_TITLE.exec(activity.title) : null
  if (titled)
    return {
      server: titled[1],
      tool: titled[2],
      ...(activity.rawInput !== undefined ? { arguments: activity.rawInput } : {})
    }
  return null
}

/** `parseMcpToolCall` for the render path, cached per activity object. */
export const mcpToolCallFor = memoizePerActivity(parseMcpToolCall)

/**
 * The arguments as lines, pretty-printed so a nested object is readable rather than one long
 * line. Empty when the adapter reported no arguments, or reported something that isn't JSON.
 */
export function mcpArgumentLines(call: McpToolCall): string[] {
  if (call.arguments === undefined || call.arguments === null) return []
  const record = asRecord(call.arguments)
  if (record && Object.keys(record).length === 0) return []
  try {
    const text = typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments, null, 2)
    return text ? text.split('\n') : []
  } catch {
    return []
  }
}

/**
 * What the server actually answered. codex-acp nests it under `rawOutput.result`; everything else
 * arrives as ACP content. An error is reported as text too, since the card's own failed status
 * already says which it was.
 */
export function mcpResultText(activity: AgentActivity): string | undefined {
  const rawOutput = asRecord(activity.rawOutput)
  const payload = rawOutput?.error ?? rawOutput?.result
  if (payload !== undefined && payload !== null) {
    if (typeof payload === 'string') return payload
    try {
      return JSON.stringify(payload, null, 2)
    } catch {
      return undefined
    }
  }
  return activity.content
}

/**
 * The card's body as data, bounded the way the shell expects. Arguments get the budget first:
 * they are what says *what the server was asked to do*, and a reader who cannot see that has no
 * way to judge a third-party call. The result is what goes behind "show more".
 */
export function mcpToolCallCard(
  activity: AgentActivity,
  budget: number | null
): { call: McpToolCall; args: string[]; result: string[]; hiddenLines: number } | null {
  const call = mcpToolCallFor(activity)
  if (!call) return null
  const allArgs = mcpArgumentLines(call)
  const args = budget === null ? allArgs : allArgs.slice(0, Math.max(0, budget))
  const result = toolOutputLines(mcpResultText(activity), budget === null ? null : Math.max(0, budget - args.length))
  return {
    call,
    args,
    result: result.lines,
    hiddenLines: allArgs.length - args.length + result.hiddenLines
  }
}

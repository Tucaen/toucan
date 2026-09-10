import type { AgentActivity } from '../../shared/agent'
import { toolOutputLines } from './tool-card'
import { asRecord, memoizePerActivity } from './tool-input'

import { parseMcpToolCall, type McpToolCall } from '../../shared/tool-identity'
export { parseMcpToolCall, type McpToolCall } from '../../shared/tool-identity'

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

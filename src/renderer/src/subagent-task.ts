import { createContext } from 'react'
import type { AgentActivity } from '../../shared/agent'
import { activityTitle, isSettledActivity } from '../../shared/agent-activity'
import { mcpToolCallFor } from './mcp-tool-call'
import { asRecord, asText, normalizeToolName } from './tool-input'

/**
 * A turn handed to a subagent. Two things make it worth its own card: it is the one tool call
 * whose duration is measured in minutes rather than seconds, and it is the only one whose work
 * happens somewhere else - so a card that shows only "running" is opaque for exactly as long as
 * the call matters.
 */
export interface SubagentTask {
  /** Which agent was asked - Claude's `subagent_type`, or the leaf of codex's `agentPath`. */
  agentType?: string
  /** The short label the caller wrote for the delegation. */
  description?: string
  /** The full instructions handed over, when the adapter forwarded them. */
  prompt?: string
  /** A model the caller pinned for the subagent, when it named one. */
  model?: string
}

const DELEGATION_TOOLS = new Set(['task', 'agent'])

/**
 * Recognizes a delegation from the adapter's own marker first (`_meta.claudeCode.subagent`,
 * `_meta.codex.subagent`) and the tool name second. The name check is deliberately last and
 * deliberately excludes MCP calls: a third-party `mcp__tracker__task` flattens to the same bare
 * `task`, and claiming it here would show somebody's issue tracker as a spawned agent.
 */
export function parseSubagentTask(activity: AgentActivity): SubagentTask | null {
  const name = normalizeToolName(activity.toolName)
  const named = name !== undefined && DELEGATION_TOOLS.has(name) && mcpToolCallFor(activity) === null
  if (!activity.subagent && !named) return null

  const input = asRecord(activity.rawInput) ?? {}
  const agentPath = asText(input.agentPath)
  const agentType = asText(input.subagent_type)
    ?? asText(input.subagentType)
    ?? asText(input.agent_type)
    ?? (agentPath ? agentPath.split('/').filter(Boolean).at(-1) : undefined)
  const description = asText(input.description) ?? asText(input.task)
  return {
    ...(agentType ? { agentType } : {}),
    ...(description ? { description } : {}),
    ...(asText(input.prompt) ? { prompt: asText(input.prompt) } : {}),
    ...(asText(input.model) ? { model: asText(input.model) } : {})
  }
}

const parsedTasks = new WeakMap<AgentActivity, SubagentTask | null>()

/** `parseSubagentTask` for the render path, cached the way `fileOperationFor` is. */
export function subagentTaskFor(activity: AgentActivity): SubagentTask | null {
  const cached = parsedTasks.get(activity)
  if (cached !== undefined) return cached
  const task = parseSubagentTask(activity)
  parsedTasks.set(activity, task)
  return task
}

/**
 * The delegation's one-line identity: who it went to and what it was asked for. Falls back to
 * ACP's own title rather than inventing one, because an adapter that reports neither field still
 * titles the call.
 */
export function subagentTaskSummary(task: SubagentTask, activity: AgentActivity): string {
  const description = task.description ?? (task.agentType ? undefined : activityTitle(activity))
  if (task.agentType && description) return `${task.agentType} — ${description}`
  return task.agentType ?? description ?? activityTitle(activity)
}

/**
 * The subagent's own work, as the reader should see it while it happens: how many of its tool
 * calls have settled, and what it is doing right now. This is the whole point of the card - a
 * delegation with no progress line is a spinner that sits at "running" for minutes.
 */
export interface SubagentProgress {
  total: number
  settled: number
  /** The step still running (or, once everything settled, the last one), for the header. */
  current?: string
}

export function subagentProgress(children: readonly AgentActivity[]): SubagentProgress | undefined {
  if (children.length === 0) return undefined
  const settled = children.filter((child) => isSettledActivity(child.status)).length
  const running = children.find((child) => !isSettledActivity(child.status))
  const current = running ?? children.at(-1)
  return {
    total: children.length,
    settled,
    ...(current ? { current: activityTitle(current) } : {})
  }
}

/** `4 of 7 steps` while it works, `7 steps` once it is done - never a bare, frozen "running". */
export function subagentProgressLabel(progress: SubagentProgress): string {
  const steps = progress.total === 1 ? 'step' : 'steps'
  return progress.settled === progress.total
    ? `${progress.total} ${steps}`
    : `${progress.settled} of ${progress.total} ${steps}`
}

/**
 * Groups every tool call a subagent made under the delegation that spawned it. Only calls whose
 * parent is actually in this worklog are grouped: an orphan (a replay that dropped the spawning
 * call, or a parent scrolled out of a trimmed feed) keeps its own top-level card rather than
 * vanishing into a parent that isn't there.
 */
export function indexSubagentActivities(
  activities: readonly AgentActivity[]
): Map<string, AgentActivity[]> {
  const known = new Set(activities.map((activity) => activity.id))
  const children = new Map<string, AgentActivity[]>()
  for (const activity of activities) {
    const parent = activity.parentToolCallId
    if (!parent || !known.has(parent)) continue
    const group = children.get(parent) ?? []
    group.push(activity)
    children.set(parent, group)
  }
  return children
}

/**
 * A subagent's tool calls, keyed by the delegation they belong to. The cards that render them sit
 * inside the shell's own body rendering, so like `WorkspaceRootsContext` this travels as context
 * rather than through every card signature.
 */
export const SubagentActivitiesContext = createContext<ReadonlyMap<string, readonly AgentActivity[]>>(new Map())

import { createContext } from 'react'
import type { AgentActivity } from '../../shared/agent'
import { activityTitle, isSettledActivity } from '../../shared/agent-activity'
import { isDelegationActivity } from '../../shared/tool-identity'
import { asRecord, asText, memoizePerActivity } from './tool-input'

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
  /**
   * The codex conversation this delegation belongs to. codex-acp reports each interaction with a
   * subagent as its own top-level tool call and never nests, so this shared id is the only thing
   * tying the three of them (`started`, `interacted`, `interrupted`) to one delegation.
   */
  threadId?: string
}

/**
 * What codex-acp reported this particular interaction as. Claude sends nothing like it: a `Task`
 * call *is* the whole delegation. Without it every codex interaction with one subagent renders as
 * the bare agent name, and an interrupt is indistinguishable from a start.
 */
const CODEX_ACTIVITY_VERBS: Record<string, string> = {
  started: 'Started',
  interacted: 'Working',
  interrupted: 'Interrupted'
}

/**
 * Recognizes a delegation from the adapter's own marker first (`_meta.claudeCode.subagent`,
 * `_meta.codex.subagent`) and the tool name second. The name check is deliberately last and
 * deliberately excludes MCP calls: a third-party `mcp__tracker__task` flattens to the same bare
 * `task`, and claiming it here would show somebody's issue tracker as a spawned agent.
 */
export function parseSubagentTask(activity: AgentActivity): SubagentTask | null {
  if (!isDelegationActivity(activity)) return null

  const input = asRecord(activity.rawInput) ?? {}
  const agentPath = asText(input.agentPath)
  const agentType =
    asText(input.subagent_type) ??
    asText(input.subagentType) ??
    asText(input.agent_type) ??
    (agentPath ? agentPath.split('/').filter(Boolean).at(-1) : undefined)
  const activityKind = asText(input.activityKind) ?? asText(input.activity_kind)
  const description =
    asText(input.description) ?? asText(input.task) ?? (activityKind ? CODEX_ACTIVITY_VERBS[activityKind] : undefined)
  return {
    ...(agentType ? { agentType } : {}),
    ...(description ? { description } : {}),
    ...(asText(input.prompt) ? { prompt: asText(input.prompt) } : {}),
    ...(asText(input.model) ? { model: asText(input.model) } : {}),
    ...(asText(input.agentThreadId) ? { threadId: asText(input.agentThreadId) } : {})
  }
}

/** `parseSubagentTask` for the render path, cached per activity object. */
export const subagentTaskFor = memoizePerActivity(parseSubagentTask)

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
 * Groups a subagent's work under the delegation it belongs to. The two adapters need two
 * different links, because they report delegation in two different shapes:
 *
 * - claude-agent-acp nests: the subagent's own tool calls arrive in the top-level feed carrying
 *   `parentToolCallId`, so the link is that id.
 * - codex-acp never nests. It reports each interaction with a subagent (`started`, `interacted`,
 *   `interrupted`) as its own top-level call sharing one `agentThreadId`, and forwards none of
 *   the subagent's tool calls at all. The first call for a thread is therefore the delegation and
 *   the rest are its progress - which is the only progress codex reports.
 *
 * Only links whose owner is actually in this worklog are made: an orphan (a replay that dropped
 * the spawning call, or a parent scrolled out of a trimmed feed) keeps its own top-level card
 * rather than vanishing into a parent that isn't there.
 */
export function indexSubagentActivities(activities: readonly AgentActivity[]): Map<string, AgentActivity[]> {
  const known = new Set(activities.map((activity) => activity.id))
  const children = new Map<string, AgentActivity[]>()
  const threadOwners = new Map<string, string>()
  const nest = (owner: string, child: AgentActivity): void => {
    const group = children.get(owner) ?? []
    group.push(child)
    children.set(owner, group)
  }
  for (const activity of activities) {
    const parent = activity.parentToolCallId
    if (parent) {
      if (known.has(parent)) nest(parent, activity)
      continue
    }
    const threadId = subagentTaskFor(activity)?.threadId
    if (!threadId) continue
    const owner = threadOwners.get(threadId)
    if (owner === undefined) threadOwners.set(threadId, activity.id)
    else nest(owner, activity)
  }
  return children
}

/**
 * A subagent's tool calls, keyed by the delegation they belong to. The cards that render them sit
 * inside the shell's own body rendering, so like `WorkspaceRootsContext` this travels as context
 * rather than through every card signature.
 */
export const SubagentActivitiesContext = createContext<ReadonlyMap<string, readonly AgentActivity[]>>(new Map())

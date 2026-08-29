import type { AgentActivity, AgentPlanEntry } from '../../shared/agent'
import { mcpToolCallFor } from './mcp-tool-call'
import { asRecord, asText, memoizePerActivity, normalizeToolName } from './tool-input'

/**
 * A tool call that rewrote the plan. Normally the reader never sees one: both adapters translate
 * their todo/task tools into ACP `plan` notifications and suppress the tool call, so the plan rail
 * is the single place a plan appears. The exception is the permission path - a plan write that
 * needed approval *is* surfaced as a real tool call so the request has something to point at - and
 * that is the call this card exists for, so an approved plan write folds back into the rail
 * instead of sitting beside it as a second, loose copy of the same list.
 */
export interface PlanUpdate {
  entries: AgentPlanEntry[]
}

const PLAN_TOOLS = new Set(['todowrite', 'taskcreate', 'taskupdate', 'tasklist', 'taskget', 'updateplan'])

const STATUSES: ReadonlySet<AgentPlanEntry['status']> = new Set(['pending', 'in_progress', 'completed'])
const PRIORITIES: ReadonlySet<AgentPlanEntry['priority']> = new Set(['high', 'medium', 'low'])

function planStatus(value: unknown): AgentPlanEntry['status'] {
  return typeof value === 'string' && STATUSES.has(value as AgentPlanEntry['status'])
    ? value as AgentPlanEntry['status']
    : 'pending'
}

function planPriority(value: unknown): AgentPlanEntry['priority'] {
  return typeof value === 'string' && PRIORITIES.has(value as AgentPlanEntry['priority'])
    ? value as AgentPlanEntry['priority']
    : 'medium'
}

/**
 * The entries a plan-writing call carried, across the three spellings in play: Claude's
 * `todos: [{ content, status }]`, Codex's `plan: [{ step, status }]`, and the single-item
 * `TaskCreate`/`TaskUpdate` form that names one task rather than a list.
 */
function planEntries(input: Record<string, unknown>): AgentPlanEntry[] {
  const list = Array.isArray(input.todos) ? input.todos : Array.isArray(input.plan) ? input.plan : undefined
  if (list) {
    return list.flatMap((item) => {
      const entry = asRecord(item)
      const content = asText(entry?.content) ?? asText(entry?.step) ?? asText(entry?.subject) ?? asText(entry?.description)
      return content
        ? [{ content, status: planStatus(entry?.status), priority: planPriority(entry?.priority) }]
        : []
    })
  }
  const content = asText(input.subject) ?? asText(input.description) ?? asText(input.content)
  return content ? [{ content, status: planStatus(input.status), priority: planPriority(input.priority) }] : []
}

/**
 * Recognizes a plan write by tool name, excluding MCP calls for the same reason `subagent-task.ts`
 * does: a third-party `mcp__notion__taskcreate` flattens to the same bare name. A read-only
 * `TaskList`/`TaskGet` is recognized too - it changes nothing, and its card should say so rather
 * than dumping the whole task list into the rail a second time.
 */
export function parsePlanUpdate(activity: AgentActivity): PlanUpdate | null {
  const name = normalizeToolName(activity.toolName)
  if (!name || !PLAN_TOOLS.has(name)) return null
  if (mcpToolCallFor(activity) !== null) return null
  return { entries: planEntries(asRecord(activity.rawInput) ?? {}) }
}

/** `parsePlanUpdate` for the render path, cached per activity object. */
export const planUpdateFor = memoizePerActivity(parsePlanUpdate)

/** The card's body as data: one budget line per plan entry, the rest behind "show more". */
export function planUpdateCard(
  activity: AgentActivity,
  budget: number | null
): { update: PlanUpdate; hiddenLines: number } | null {
  const update = planUpdateFor(activity)
  if (!update) return null
  if (budget === null) return { update, hiddenLines: 0 }
  const entries = update.entries.slice(0, Math.max(0, budget))
  return { update: { entries }, hiddenLines: update.entries.length - entries.length }
}

export function planUpdateSummary(update: PlanUpdate): string {
  if (update.entries.length === 0) return 'Read the plan'
  const done = update.entries.filter((entry) => entry.status === 'completed').length
  const steps = update.entries.length === 1 ? 'step' : 'steps'
  return `Updated the plan — ${update.entries.length} ${steps}, ${done} done`
}

/**
 * Whether the plan rail has already absorbed this call, so the worklog must not also show it as a
 * loose card. Two conditions, both load-bearing: the call must have *succeeded* (one still
 * pending approval, or one that failed, is not what the rail is showing - the rail shows the plan
 * the agent has, not the one it asked for and did not get), and the rail must actually be
 * rendering a plan, so a fold can never be the reason a plan write left no trace anywhere.
 */
export function isPlanUpdateFoldedIntoRail(activity: AgentActivity, railHasPlan: boolean): boolean {
  return railHasPlan && activity.status === 'completed' && planUpdateFor(activity) !== null
}

import type { ReactNode } from 'react'
import type { AgentActivity } from '../../shared/agent'
import { activityTitle } from '../../shared/agent-activity'
import { FileOperationBody, FileOperationSummary, fileOperationCard } from './FileOperationCard'
import { fileOperationFor, fileOperationIcon } from './file-operation'
import { McpToolCallBody, McpToolCallSummary } from './McpToolCallCard'
import { mcpToolCallCard, mcpToolCallFor } from './mcp-tool-call'
import { PlanUpdateBody, PlanUpdateSummary } from './PlanUpdateCard'
import { planUpdateCard, planUpdateFor } from './plan-update'
import { SkillInvocationBody, SkillInvocationSummary } from './SkillInvocationCard'
import { skillInvocationFor } from './skill-invocation'
import { SubagentTaskBody, SubagentTaskSummary } from './SubagentTaskCard'
import { subagentTaskFor } from './subagent-task'
import { toolCardStatusLabel, toolOutputLines } from './tool-card'
import { SearchNavigationBody, SearchNavigationSummary, searchNavigationCard } from './SearchNavigationCard'
import { searchNavigationFor } from './search-navigation'
import { ShellExecutionBody, ShellExecutionSummary, shellExecutionCard } from './ShellExecutionCard'
import { shellExecutionFor, shellExecutionIcon } from './shell-execution'
import { truncateToolOutput } from './tool-card'

/** How many lines of a tool body reach the DOM before the shell offers "show more". */
export const TOOL_CARD_LINE_BUDGET = 40

export interface ToolCardBody {
  content: ReactNode
  /** Lines this render left out, so the shell can label its "show more" honestly. */
  hiddenLines: number
}

/**
 * The single extension point for per-tool rendering: a family supplies an icon, the one-line
 * summary that sits in the header, and the body. Everything else - the header row, the status
 * and duration, collapse, and the truncation affordance - belongs to the shell (`ActivityCard`
 * in `ChatNode.tsx`), so a new family never re-implements chrome. A body must render within
 * `lineBudget` lines (`null` once the reader asked for everything) and report what it held back;
 * the shell surfaces the rest behind "show more".
 */
export interface ToolCardFamily {
  id: string
  matches(activity: AgentActivity): boolean
  icon(activity: AgentActivity): string
  summary(activity: AgentActivity): ReactNode
  body(activity: AgentActivity, lineBudget: number | null): ToolCardBody
}

function genericIcon(activity: AgentActivity): string {
  switch (activity.kind) {
    case 'edit':
      return '+'
    case 'delete':
      return '-'
    case 'move':
      return '->'
    case 'execute':
      return '>_'
    case 'read':
      return '[]'
    case 'search':
      return '?'
    case 'fetch':
      return '@'
    case 'think':
      return '~'
    case 'switch_mode':
      return '<>'
    default:
      return '*'
  }
}

/** The fallback every activity renders through until its family's own card lands. */
export const genericToolCardFamily: ToolCardFamily = {
  id: 'generic',
  matches: () => true,
  icon: genericIcon,
  summary: (activity) => activityTitle(activity),
  body: (activity, lineBudget) => {
    const output =
      lineBudget === null
        ? { text: activity.content ?? '', hiddenLines: 0 }
        : truncateToolOutput(activity.content, lineBudget)
    return {
      hiddenLines: output.hiddenLines,
      content: (
        <>
          {output.text && <pre>{output.text}</pre>}
          {activity.locations?.map((location) => (
            <small key={location}>{location}</small>
          ))}
        </>
      )
    }
  }
}

/**
 * Read/Write/Edit/MultiEdit/NotebookEdit. All five share one card because they share one
 * identity - a file - and differ only in what the body shows: an excerpt, a preview, or a
 * before/after (see `file-operation.ts`).
 */
export const fileOperationToolCardFamily: ToolCardFamily = {
  id: 'file-operation',
  matches: (activity) => fileOperationFor(activity) !== null,
  icon: (activity) => {
    const operation = fileOperationFor(activity)
    return operation ? fileOperationIcon(operation) : genericIcon(activity)
  },
  summary: (activity) => {
    const operation = fileOperationFor(activity)
    return operation ? <FileOperationSummary operation={operation} /> : activityTitle(activity)
  },
  body: (activity, lineBudget) => {
    const card = fileOperationCard(activity, lineBudget)
    if (!card) return genericToolCardFamily.body(activity, lineBudget)
    return {
      hiddenLines: card.hiddenLines,
      content: <FileOperationBody operation={card.operation} blocks={card.blocks} />
    }
  }
}

export const searchNavigationToolCardFamily: ToolCardFamily = {
  id: 'search-navigation',
  matches: (activity) => searchNavigationFor(activity) !== null,
  icon: (activity) => {
    const kind = searchNavigationFor(activity)?.kind
    return kind === 'web-search' || kind === 'web-fetch' ? '@' : '?'
  },
  summary: (activity) => {
    const search = searchNavigationFor(activity)
    return search ? <SearchNavigationSummary search={search} /> : activityTitle(activity)
  },
  body: (activity, lineBudget) => {
    const card = searchNavigationCard(activity, lineBudget)
    if (!card) return genericToolCardFamily.body(activity, lineBudget)
    return {
      hiddenLines: card.hiddenLines,
      content: <SearchNavigationBody search={card.search} />
    }
  }
}

/**
 * Bash, Codex's shell, and the background-shell follow-ups (BashOutput/KillShell). All share one
 * card because they share one identity - a command line - and differ only in whether the body is
 * that command's output or a later read of it (see `shell-execution.ts`).
 */
export const shellExecutionToolCardFamily: ToolCardFamily = {
  id: 'shell-execution',
  matches: (activity) => shellExecutionFor(activity) !== null,
  icon: (activity) => {
    const execution = shellExecutionFor(activity)
    return execution ? shellExecutionIcon(execution) : genericIcon(activity)
  },
  summary: (activity) => {
    const execution = shellExecutionFor(activity)
    return execution ? (
      <ShellExecutionSummary execution={execution} status={activity.status} />
    ) : (
      activityTitle(activity)
    )
  },
  body: (activity, lineBudget) => {
    const card = shellExecutionCard(activity, lineBudget)
    if (!card) return genericToolCardFamily.body(activity, lineBudget)
    return {
      hiddenLines: card.hiddenLines,
      content: <ShellExecutionBody execution={card.execution} blocks={card.blocks} />
    }
  }
}

/**
 * One line per step a subagent took. Deliberately *not* a card: it reuses the shell's icon and
 * status classes so a nested Grep reads as the same thing it would at the top level, but it has
 * no duration, no collapse and no body, because a card inside a card would give the reader two
 * scrolling, independently-collapsing surfaces for one delegation. Only the family's `summary` is
 * called, never its `body`, so a subagent that itself delegates cannot nest without bound.
 */
function subagentStepRow(step: AgentActivity): ReactNode {
  const family = toolCardFamilyFor(step)
  return (
    <div className="subagent-step" data-status={step.status ?? 'in_progress'} key={step.id}>
      <span className="activity-icon">{family.icon(step)}</span>
      <strong>{family.summary(step)}</strong>
      <span className="activity-state">{toolCardStatusLabel(step.status)}</span>
    </div>
  )
}

/**
 * A turn handed to a subagent. The body is where the delegation stops being opaque: it carries
 * the subagent's own tool calls, live, rather than one entry that sits at "running" for minutes
 * (see `subagent-task.ts`).
 */
export const subagentTaskToolCardFamily: ToolCardFamily = {
  id: 'subagent-task',
  matches: (activity) => subagentTaskFor(activity) !== null,
  icon: () => '<>',
  summary: (activity) => {
    const task = subagentTaskFor(activity)
    return task ? <SubagentTaskSummary task={task} activity={activity} /> : activityTitle(activity)
  },
  body: (activity, lineBudget) => {
    const task = subagentTaskFor(activity)
    if (!task) return genericToolCardFamily.body(activity, lineBudget)
    // The steps are the point of the card, so the budget is spent on the report the subagent
    // handed back - never on hiding the progress the reader opened the card to see.
    const output = toolOutputLines(activity.content, lineBudget)
    return {
      hiddenLines: output.hiddenLines,
      content: <SubagentTaskBody task={task} activity={activity} result={output.lines} renderStep={subagentStepRow} />
    }
  }
}

/**
 * A todo/task write the adapter surfaced as a real tool call. Normally there is nothing to render
 * - both adapters translate these into the `plan` notification the current plan card draws - so this family
 * exists for the permission path, and `worklogActivities` is what keeps it from ever duplicating
 * the plan card (see `plan-update.ts`).
 */
export const planUpdateToolCardFamily: ToolCardFamily = {
  id: 'plan-update',
  matches: (activity) => planUpdateFor(activity) !== null,
  icon: () => '=',
  summary: (activity) => {
    const update = planUpdateFor(activity)
    return update ? <PlanUpdateSummary update={update} /> : activityTitle(activity)
  },
  body: (activity, lineBudget) => {
    const card = planUpdateCard(activity, lineBudget)
    if (!card) return genericToolCardFamily.body(activity, lineBudget)
    return { hiddenLines: card.hiddenLines, content: <PlanUpdateBody update={card.update} /> }
  }
}

/** A skill or slash command the agent loaded, named rather than left as a bare "Skill". */
export const skillInvocationToolCardFamily: ToolCardFamily = {
  id: 'skill-invocation',
  matches: (activity) => skillInvocationFor(activity) !== null,
  icon: () => '/',
  summary: (activity) => {
    const invocation = skillInvocationFor(activity)
    return invocation ? <SkillInvocationSummary invocation={invocation} /> : activityTitle(activity)
  },
  body: (activity, lineBudget) => {
    const invocation = skillInvocationFor(activity)
    if (!invocation) return genericToolCardFamily.body(activity, lineBudget)
    const output = toolOutputLines(activity.content, lineBudget)
    return {
      hiddenLines: output.hiddenLines,
      content: <SkillInvocationBody invocation={invocation} output={output.lines} />
    }
  }
}

/** A tool a connected MCP server provides, kept visibly distinct from the built-ins. */
export const mcpToolCallToolCardFamily: ToolCardFamily = {
  id: 'mcp-tool-call',
  matches: (activity) => mcpToolCallFor(activity) !== null,
  icon: () => '::',
  summary: (activity) => {
    const call = mcpToolCallFor(activity)
    return call ? <McpToolCallSummary call={call} /> : activityTitle(activity)
  },
  body: (activity, lineBudget) => {
    const card = mcpToolCallCard(activity, lineBudget)
    if (!card) return genericToolCardFamily.body(activity, lineBudget)
    return {
      hiddenLines: card.hiddenLines,
      content: <McpToolCallBody call={card.call} args={card.args} result={card.result} />
    }
  }
}

/**
 * Families registered by the per-tool sub-issues, most specific first. MCP leads: a third-party
 * tool's bare name can collide with any built-in's (`mcp__tracker__task`, `mcp__x__grep`), and
 * every other family's recognizer flattens the namespace away. Anything no family claims falls
 * through to the generic family.
 */
export const toolCardFamilies: ToolCardFamily[] = [
  mcpToolCallToolCardFamily,
  subagentTaskToolCardFamily,
  planUpdateToolCardFamily,
  skillInvocationToolCardFamily,
  shellExecutionToolCardFamily,
  fileOperationToolCardFamily,
  searchNavigationToolCardFamily
]

export function toolCardFamilyFor(activity: AgentActivity): ToolCardFamily {
  return toolCardFamilies.find((family) => family.matches(activity)) ?? genericToolCardFamily
}

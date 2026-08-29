import type { ReactNode } from 'react'
import type { AgentActivity } from '../../shared/agent'
import { activityTitle } from '../../shared/agent-activity'
import { FileOperationBody, FileOperationSummary, fileOperationCard } from './FileOperationCard'
import { fileOperationFor, fileOperationIcon } from './file-operation'
import {
  SearchNavigationBody,
  SearchNavigationSummary,
  searchNavigationCard
} from './SearchNavigationCard'
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
    case 'edit': return '+'
    case 'delete': return '-'
    case 'move': return '->'
    case 'execute': return '>_'
    case 'read': return '[]'
    case 'search': return '?'
    case 'fetch': return '@'
    case 'think': return '~'
    case 'switch_mode': return '<>'
    default: return '*'
  }
}

/** The fallback every activity renders through until its family's own card lands. */
export const genericToolCardFamily: ToolCardFamily = {
  id: 'generic',
  matches: () => true,
  icon: genericIcon,
  summary: (activity) => activityTitle(activity),
  body: (activity, lineBudget) => {
    const output = lineBudget === null
      ? { text: activity.content ?? '', hiddenLines: 0 }
      : truncateToolOutput(activity.content, lineBudget)
    return {
      hiddenLines: output.hiddenLines,
      content: (
        <>
          {output.text && <pre>{output.text}</pre>}
          {activity.locations?.map((location) => <small key={location}>{location}</small>)}
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
    return operation
      ? <FileOperationSummary operation={operation} />
      : activityTitle(activity)
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
    return execution
      ? <ShellExecutionSummary execution={execution} status={activity.status} />
      : activityTitle(activity)
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
 * Families registered by the per-tool sub-issues, most specific first. Anything no family
 * claims falls through to the generic family.
 */
export const toolCardFamilies: ToolCardFamily[] = [
  shellExecutionToolCardFamily,
  fileOperationToolCardFamily,
  searchNavigationToolCardFamily
]

export function toolCardFamilyFor(activity: AgentActivity): ToolCardFamily {
  return toolCardFamilies.find((family) => family.matches(activity)) ?? genericToolCardFamily
}

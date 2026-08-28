import type { ReactNode } from 'react'
import type { AgentActivity } from '../../shared/agent'
import { activityTitle } from '../../shared/agent-activity'
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
 * Families registered by the per-tool sub-issues, most specific first. Empty today: every
 * activity falls through to the generic family.
 */
export const toolCardFamilies: ToolCardFamily[] = []

export function toolCardFamilyFor(activity: AgentActivity): ToolCardFamily {
  return toolCardFamilies.find((family) => family.matches(activity)) ?? genericToolCardFamily
}

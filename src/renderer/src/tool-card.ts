import type { AgentActivity } from '../../shared/agent'
import { isSettledActivity } from '../../shared/agent-activity'

export type ToolCardStatus = NonNullable<AgentActivity['status']>

const TOOL_CARD_STATUS_LABELS: Record<ToolCardStatus, string> = {
  pending: 'queued',
  in_progress: 'running',
  completed: 'done',
  failed: 'failed'
}

/**
 * How a call's status reads in a header. Shared by the card shell and the nested step rows a
 * delegation card renders, so one state can never be spelled two ways in the same rail.
 */
export function toolCardStatusLabel(status: ToolCardStatus | undefined): string {
  return TOOL_CARD_STATUS_LABELS[status ?? 'in_progress']
}

/**
 * A tool card's open/closed state before any reader input: a call the agent is still working on
 * is worth watching, a failure is worth reading, and a completed call is noise once its one-line
 * summary says what it did.
 */
export function defaultToolCardExpanded(status: ToolCardStatus | undefined): boolean {
  return status !== 'completed'
}

/** A reader's toggle, remembered together with the status it was made under. */
export interface ToolCardChoice {
  expanded: boolean
  status: ToolCardStatus | undefined
}

/**
 * A reader's explicit toggle outranks the status default and keeps outranking it - except that
 * a call which has failed *since* the toggle re-opens itself, so collapsing a card while it was
 * still working can never hide the error it went on to produce.
 */
export function resolveToolCardExpanded(
  status: ToolCardStatus | undefined,
  choice: ToolCardChoice | undefined
): boolean {
  if (!choice) return defaultToolCardExpanded(status)
  if (status === 'failed' && choice.status !== 'failed') return true
  return choice.expanded
}

/** Sub-second precision only where it reads as fast; minutes once seconds stop being legible. */
export function formatToolDuration(milliseconds: number | undefined): string | undefined {
  if (milliseconds === undefined) return undefined
  const clamped = Math.max(0, milliseconds)
  if (clamped < 10_000) return `${(Math.floor(clamped / 100) / 10).toFixed(1)}s`
  const seconds = Math.floor(clamped / 1000)
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`
}

/** Counts up while the call is working and freezes at the stamped end once it settles. */
export function toolCardElapsed(activity: AgentActivity, now: number): number | undefined {
  if (activity.startedAt === undefined) return undefined
  return (activity.endedAt ?? now) - activity.startedAt
}

/** Whether a card's duration has stopped moving, so its clock can be shut off. */
export function toolCardIsTiming(activity: AgentActivity): boolean {
  return !isSettledActivity(activity.status)
}

export interface TruncatedToolOutput {
  text: string
  /** Lines this render left out, so the card can offer them behind an explicit "show more". */
  hiddenLines: number
}

/**
 * Bounds what a tool body puts into the DOM at all, so one enormous result can never cost the
 * rail its scroll height (or the renderer 5000 laid-out lines). The remainder is counted rather
 * than silently dropped.
 */
export function truncateToolOutput(text: string | undefined, maxLines: number): TruncatedToolOutput {
  if (!text) return { text: '', hiddenLines: 0 }
  const lines = text.split('\n')
  if (lines.length <= maxLines) return { text, hiddenLines: 0 }
  return { text: lines.slice(0, maxLines).join('\n'), hiddenLines: lines.length - maxLines }
}

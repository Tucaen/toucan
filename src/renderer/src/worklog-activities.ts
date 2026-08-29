import type { AgentActivity } from '../../shared/agent'
import { isPlanUpdateFoldedIntoRail } from './plan-update'
import { indexSubagentActivities } from './subagent-task'

/**
 * Which activities get a card of their own in the worklog. Two things are deliberately *not*
 * shown at the top level, because showing them there is what makes the rail read as a flat,
 * undifferentiated stream:
 *
 * - a subagent's own tool calls, which belong inside the delegation that spawned them
 *   (`indexSubagentActivities`), and
 * - a plan write the plan rail has already absorbed (`isPlanUpdateFoldedIntoRail`).
 *
 * Nothing is dropped outright: both rules require the thing that replaces the card to actually be
 * present, so an activity always renders *somewhere*.
 */
export function worklogActivities(
  activities: readonly AgentActivity[],
  railHasPlan: boolean
): AgentActivity[] {
  const nested = indexSubagentActivities(activities)
  const delegated = new Set(Array.from(nested.values()).flat().map((activity) => activity.id))
  return activities.filter((activity) => (
    !delegated.has(activity.id) && !isPlanUpdateFoldedIntoRail(activity, railHasPlan)
  ))
}

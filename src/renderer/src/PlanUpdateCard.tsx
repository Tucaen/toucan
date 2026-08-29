import type { JSX } from 'react'
import type { PlanUpdate } from './plan-update'
import { planUpdateSummary } from './plan-update'

export function PlanUpdateSummary({ update }: { update: PlanUpdate }): JSX.Element {
  return <span className="plan-update-summary">{planUpdateSummary(update)}</span>
}

/**
 * The same list the plan rail draws, in the rail's own shape. A card only ever renders when the
 * rail has *not* absorbed this write (`isPlanUpdateFoldedIntoRail`), so the two are alternatives,
 * never a duplicate pair.
 */
export function PlanUpdateBody({ update }: { update: PlanUpdate }): JSX.Element {
  return update.entries.length === 0
    ? <p className="plan-update-empty">The agent read the plan without changing it.</p>
    : (
      <ol className="plan-list plan-update-list">
        {update.entries.map((entry, index) => (
          <li data-status={entry.status} key={`${index}-${entry.content}`}>{entry.content}</li>
        ))}
      </ol>
    )
}

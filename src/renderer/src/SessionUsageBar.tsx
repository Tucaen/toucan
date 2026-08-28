import { memo } from 'react'
import type { SessionUsageReadout } from './session-usage'

/**
 * The chat node's usage row: how full the context window is, what the conversation has cost, and
 * the account window closest to biting. Every decision it renders was already made by
 * `describeSessionUsage`, so this file is markup only.
 *
 * It takes the finished readout rather than the raw usage because its caller has to know whether
 * there is anything to show before it reserves the row at all - and memoizing on that one stable
 * object keeps the bar out of the streaming render path, where a chunk arrives many times per
 * turn but a `usage_update` does not.
 */
function SessionUsageBar({ readout }: { readout: SessionUsageReadout }): JSX.Element | null {
  if (readout.empty) return null
  const { context, tokens, cost, limit } = readout

  return (
    <>
      {context && (
        <span className="session-usage-context usage-window" data-level={context.level} title={context.title}>
          <span className="usage-window-label">Context</span>
          <span className="usage-window-bar">
            <span className="usage-window-fill" style={{ width: `${context.percent}%` }} />
          </span>
          <span className="usage-window-pct">{context.percent}%</span>
          <small className="session-usage-tokens">{context.label}</small>
        </span>
      )}
      {tokens && <span className="session-usage-tokens-only" title={tokens.title}>{tokens.label}</span>}
      {cost && <span className="session-usage-cost" title={cost.title}>{cost.label}</span>}
      {limit && (
        <span
          className="session-usage-limit usage-window"
          data-level={limit.level}
          data-rejected={limit.rejected ? 'true' : undefined}
          title={limit.title}
        >
          <span className="usage-window-label">{limit.label}</span>
          <span className="usage-window-pct">{limit.displayPercent}%</span>
        </span>
      )}
      {/* The warning is the point of the whole row: it has to be readable without hovering, so it
          is text rather than a tooltip on the gauge. */}
      {context?.warning && (
        <strong className="session-usage-warning" data-level={context.level} role="status">
          {context.warning}
        </strong>
      )}
    </>
  )
}

export default memo(SessionUsageBar)

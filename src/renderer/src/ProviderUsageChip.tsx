import type { CSSProperties } from 'react'
import type { AgentProvider } from '../../shared/agent'
import { describeRateLimitWindows, describeUsageFreshness } from './session-usage'
import type { RateLimitWindowReadout } from './session-usage'
import { REFRESH_FLASH_MS, useRefreshFlash } from './use-refresh-flash'
import type { ProviderUsageView } from './use-provider-rate-limits'

/** What each provider calls itself in the header; the `AgentProvider` id is lowercase wiring. */
const PROVIDER_LABELS: Record<AgentProvider, string> = {
  claude: 'Claude',
  codex: 'Codex'
}

// Thresholds, clamping and wording come from the same readout the tooltip is built from, shared
// with the per-node usage bar, so one window never reads as two different states anywhere shown.
function UsageWindow({ window }: { window: RateLimitWindowReadout }): JSX.Element {
  const { label, level, displayPercent, resetProgressPercent } = window
  return (
    <span className="usage-window" data-level={level}>
      <span className="usage-window-label">{label}</span>
      <span className="usage-window-bar">
        <span className="usage-window-fill" style={{ width: `${displayPercent}%` }} />
        {resetProgressPercent !== undefined && (
          <span className="usage-window-reset" style={{ left: `${resetProgressPercent}%` }} />
        )}
      </span>
      <span className="usage-window-pct">{displayPercent}%</span>
    </span>
  )
}

/**
 * Not every plan meters both windows - a Codex plan may report only the one it bills against - and
 * some add a per-model allowance (Claude's weekly Fable window), so a chip renders just the windows
 * its provider actually reported, plan-wide ones first.
 *
 * The chip is also the button that refreshes it. Usage is otherwise only as fresh as the poll, and
 * the moment a user actually cares about the number - right after a long turn, or after waiting out
 * a limit - is exactly the moment a minute-old reading is the wrong one to be looking at. Since plan
 * utilization rarely moves between two clicks, the chip has to date and confirm its own reading, or
 * a refresh that worked is indistinguishable from a button that does nothing.
 */
export function ProviderUsageChip({
  provider,
  entry,
  onRefresh
}: {
  provider: AgentProvider
  entry: ProviderUsageView
  onRefresh(provider: AgentProvider): void
}): JSX.Element {
  const { status, refreshing, stale } = entry
  const label = PROVIDER_LABELS[provider]
  const flashing = useRefreshFlash(refreshing, stale)

  const windows = describeRateLimitWindows(status)
  // `describeRateLimitWindows` lists plan-wide windows first, then per-model allowances; the chip
  // keeps the plan windows on the first row and gives the model windows a row of their own.
  const planCount = (status.fiveHour ? 1 : 0) + (status.weekly ? 1 : 0)
  const planWindows = windows.slice(0, planCount)
  const modelWindows = windows.slice(planCount)
  const title = [
    `${label} account usage`,
    ...windows.map((window) => window.text),
    status.rejected ? 'Limit reached' : null,
    describeUsageFreshness(entry),
    refreshing ? 'Refreshing…' : 'Click to refresh'
  ]
    .filter(Boolean)
    .join('\n')

  return (
    <button
      type="button"
      className="provider-usage-chip"
      data-rejected={status.rejected ? 'true' : undefined}
      data-refreshing={refreshing ? 'true' : undefined}
      data-stale={stale ? 'true' : undefined}
      data-refreshed={flashing ? 'true' : undefined}
      // The cue's length is one number; the stylesheet reads it from here rather than restating it.
      style={{ '--usage-refresh-flash': `${REFRESH_FLASH_MS}ms` } as CSSProperties}
      title={title}
      disabled={refreshing}
      onClick={() => onRefresh(provider)}
    >
      <span
        className="provider-usage-name"
        data-provider={provider}
        data-critical={status.rejected || windows.some((window) => window.level === 'critical') ? 'true' : undefined}
      >
        {label}
      </span>
      <span className="provider-usage-windows">
        {planWindows.length > 0 && (
          <span className="provider-usage-row">
            {planWindows.map((window) => (
              <UsageWindow key={window.label} window={window} />
            ))}
          </span>
        )}
        {modelWindows.length > 0 && (
          <span className="provider-usage-row">
            {modelWindows.map((window) => (
              <UsageWindow key={window.label} window={window} />
            ))}
          </span>
        )}
      </span>
    </button>
  )
}

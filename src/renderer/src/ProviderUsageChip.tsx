import type { CSSProperties } from 'react'
import type { AgentProvider, AgentRateLimitWindow } from '../../shared/agent'
import { describeRateLimitWindow, describeRateLimitWindows, describeUsageFreshness } from './session-usage'
import { REFRESH_FLASH_MS, useRefreshFlash } from './use-refresh-flash'
import type { ProviderUsageView } from './use-provider-rate-limits'

/** What each provider calls itself in the header; the `AgentProvider` id is lowercase wiring. */
const PROVIDER_LABELS: Record<AgentProvider, string> = {
  claude: 'Claude',
  codex: 'Codex'
}

function UsageWindow({ label, window }: { label: string; window: AgentRateLimitWindow }): JSX.Element {
  // Thresholds, clamping and wording are shared with the per-node usage bar so one window never
  // reads as two different states in the two places it is shown.
  const { level, displayPercent } = describeRateLimitWindow(label, window)
  return (
    <span className="usage-window" data-level={level}>
      <span className="usage-window-label">{label}</span>
      <span className="usage-window-bar">
        <span className="usage-window-fill" style={{ width: `${displayPercent}%` }} />
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
      <span className="provider-usage-name">{label}</span>
      {status.fiveHour && <UsageWindow label="5h" window={status.fiveHour} />}
      {status.weekly && <UsageWindow label="7d" window={status.weekly} />}
      {(status.models ?? []).map((model) => (
        <UsageWindow key={model.label} label={model.label} window={model} />
      ))}
    </button>
  )
}

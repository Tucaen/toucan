import type { FirstMateQuotaStatus, FirstMateQuotaWindow } from '../../shared/firstmate'
import type { AgentUsage } from './use-agent-conversation'

function formatTokenCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return String(value)
}

function formatResetsAt(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

/** Permanent, no-hover display of the conversation's live context-window usage. */
export function UsageStat({ usage, compact = false }: { usage: AgentUsage | null; compact?: boolean }): JSX.Element {
  const { used, size, cost } = usage ?? {}
  const percent = used != null && size ? Math.round((used / size) * 100) : null
  const title = used != null && size != null
    ? `Context usage: ${used.toLocaleString()} / ${size.toLocaleString()} tokens${cost ? ` · cost ${cost}` : ''}`
    : 'Context usage is not yet available for this conversation.'
  return (
    <span className="usage-stat" title={title}>
      <span className="usage-stat-label">Ctx</span>
      <span className="usage-stat-value">
        {percent === null
          ? '—'
          : compact
          ? `${percent}%`
          : `${formatTokenCount(used!)}/${formatTokenCount(size!)} · ${percent}%`}
      </span>
      {!compact && cost && <span className="usage-stat-cost">{cost}</span>}
    </span>
  )
}

interface QuotaWindowDisplay {
  key: string
  name: string
  shortLabel: string
  window: FirstMateQuotaWindow
}

/** Permanent, no-hover display of the account's hourly (session) and weekly usage-limit windows. */
export function QuotaStat({ quota, compact = false }: { quota: FirstMateQuotaStatus | null; compact?: boolean }): JSX.Element {
  const windows: QuotaWindowDisplay[] = quota?.state === 'ok'
    ? [
      quota.session && { key: 'session', name: 'Session (5h)', shortLabel: '5h', window: quota.session },
      quota.week && { key: 'week', name: 'Weekly', shortLabel: 'wk', window: quota.week }
    ].filter((entry): entry is QuotaWindowDisplay => Boolean(entry))
    : []

  if (windows.length === 0) {
    // `quota === null` is the ordinary "hasn't polled yet" gap and gets a neutral dash; a
    // resolved `state: 'unavailable'` report is an actual failure (e.g. an auth problem) and
    // needs a signal visible without hovering, not just the tooltip below.
    const isError = quota?.state === 'unavailable'
    return (
      <span
        className="quota-stat"
        data-state={isError ? 'unavailable' : 'loading'}
        title={quota?.message ?? 'Usage-limit status has not loaded yet.'}
      >
        <span className="usage-stat-label">Limits</span>
        <span className="usage-stat-value">—</span>
        {isError && (
          <span className="quota-stat-warning" aria-hidden="true">!</span>
        )}
      </span>
    )
  }

  return (
    <span className="quota-stat" data-state="ok">
      <span className="usage-stat-label">Limits</span>
      {windows.map(({ key, name, shortLabel, window }) => (
        <span
          key={key}
          className="quota-stat-window"
          title={`${name} window: ${window.percentRemaining}% remaining, resets ${formatResetsAt(window.resetsAt)}`}
        >
          {window.percentRemaining}%{compact ? '' : ` ${shortLabel}`}
        </span>
      ))}
    </span>
  )
}

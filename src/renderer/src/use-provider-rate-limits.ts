import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  keptAsStale,
  type AgentProvider,
  type ProviderRateLimits,
  type ProviderUsageEntry,
  type ProviderUsageReport
} from '../../shared/agent'

/** The main process caches these reads, so this cadence only decides display freshness. */
const PROVIDER_USAGE_POLL_MS = 60_000

/** One provider's reading as the header draws it: the figures, their age, and whether it is busy. */
export interface ProviderUsageView extends ProviderUsageEntry {
  /** True only for a refresh the user asked for on this provider, so the poll never flickers it. */
  refreshing: boolean
}

export interface ProviderRateLimitsState {
  /** Just the figures, for nodes that read a provider's limits without caring how fresh they are. */
  limits: ProviderRateLimits
  providers: Partial<Record<AgentProvider, ProviderUsageView>>
  refresh(provider: AgentProvider): void
}

/** Writes one provider's slot, dropping it entirely when that provider has nothing to report. */
function withProvider(
  report: ProviderUsageReport,
  provider: AgentProvider,
  entry: ProviderUsageEntry | undefined
): ProviderUsageReport {
  const next = { ...report }
  if (entry) next[provider] = entry
  else delete next[provider]
  return next
}

/**
 * Folds a poll into what is already on screen. The poll is served from the host's cache, so it can
 * be answering with a reading a forced refresh has already overtaken - applying it wholesale would
 * walk a provider's reading backwards. Staleness is sticky for the same reason: only a genuinely
 * newer reading clears a failure, since a cache hit is not evidence that the provider was reachable.
 *
 * Exported for tests, which drive the orderings that are hard to provoke against a real host.
 * @internal exported for tests
 */
export function mergePolledUsage(current: ProviderUsageReport, polled: ProviderUsageReport): ProviderUsageReport {
  const next = { ...polled }
  for (const [provider, entry] of Object.entries(current) as Array<[AgentProvider, ProviderUsageEntry]>) {
    const incoming = next[provider]
    if (!incoming) continue
    if (incoming.readAt < entry.readAt) next[provider] = entry
    else if (incoming.readAt === entry.readAt && entry.stale) next[provider] = entry
  }
  return next
}

/** Owns the single account-wide usage poll shared by every conversation node. */
export function useProviderRateLimits(): ProviderRateLimitsState {
  const [report, setReport] = useState<ProviderUsageReport>({})
  const [refreshing, setRefreshing] = useState<Partial<Record<AgentProvider, boolean>>>({})
  const activeRef = useRef(true)

  useEffect(() => {
    activeRef.current = true
    const poll = async (): Promise<void> => {
      const next = await window.usageApi.rateLimits().catch(() => null)
      if (activeRef.current && next) setReport((current) => mergePolledUsage(current, next))
    }
    void poll()
    const interval = setInterval(() => void poll(), PROVIDER_USAGE_POLL_MS)
    return () => {
      activeRef.current = false
      clearInterval(interval)
    }
  }, [])

  // A click bypasses the host's cache: the user is asking because they want a fresher number than
  // the one already on screen, and the poll would otherwise hand them the same one straight back.
  // Only the clicked provider is read, so a provider whose CLI is slow or missing cannot decide how
  // long the other provider's chip sits disabled.
  const refresh = useCallback((provider: AgentProvider): void => {
    setRefreshing((current) => ({ ...current, [provider]: true }))
    void window.usageApi
      .rateLimits({ force: true, provider })
      .catch(() => null)
      .then((next) => {
        // Released ahead of the mounted check, which is false for a window during React's
        // development remount while the component is still on screen. A chip left disabled is a
        // chip the user cannot retry from, so that window must not be able to strand one.
        setRefreshing((current) => ({ ...current, [provider]: false }))
        if (!activeRef.current) return
        setReport((current) => {
          // The host marks a reading it kept through a failed read; a request that never got an
          // answer at all has to be marked here, or the failure shows as a refresh that did nothing.
          const entry = next ? next[provider] : keptAsStale(current[provider])
          return withProvider(current, provider, entry)
        })
      })
  }, [])

  const providers = useMemo(() => {
    const views: Partial<Record<AgentProvider, ProviderUsageView>> = {}
    for (const [provider, entry] of Object.entries(report) as Array<[AgentProvider, ProviderUsageEntry]>) {
      views[provider] = { ...entry, refreshing: refreshing[provider] ?? false }
    }
    return views
  }, [report, refreshing])

  const limits = useMemo(() => {
    const values: ProviderRateLimits = {}
    for (const [provider, entry] of Object.entries(report) as Array<[AgentProvider, ProviderUsageEntry]>) {
      values[provider] = entry.status
    }
    return values
  }, [report])

  return { limits, providers, refresh }
}

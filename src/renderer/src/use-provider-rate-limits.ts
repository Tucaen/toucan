import { useCallback, useEffect, useRef, useState } from 'react'
import type { ProviderRateLimits } from '../../shared/agent'

/** The main process caches these reads, so this cadence only decides display freshness. */
const PROVIDER_USAGE_POLL_MS = 60_000

export interface ProviderRateLimitsState {
  limits: ProviderRateLimits
  /** True only for a refresh the user asked for, so the poll never flickers the header. */
  refreshing: boolean
  refresh(): void
}

/** Owns the single account-wide usage poll shared by every conversation node. */
export function useProviderRateLimits(): ProviderRateLimitsState {
  const [limits, setLimits] = useState<ProviderRateLimits>({})
  const [refreshing, setRefreshing] = useState(false)
  const activeRef = useRef(true)

  useEffect(() => {
    activeRef.current = true
    const refresh = async (): Promise<void> => {
      const next = await window.usageApi.rateLimits().catch(() => null)
      if (activeRef.current && next) setLimits(next)
    }
    void refresh()
    const interval = setInterval(() => void refresh(), PROVIDER_USAGE_POLL_MS)
    return () => {
      activeRef.current = false
      clearInterval(interval)
    }
  }, [])

  // A click bypasses the host's cache: the user is asking because they want a fresher number than
  // the one already on screen, and the poll would otherwise hand them the same one straight back.
  const refresh = useCallback((): void => {
    setRefreshing(true)
    void window.usageApi
      .rateLimits({ force: true })
      .catch(() => null)
      .then((next) => {
        if (!activeRef.current) return
        if (next) setLimits(next)
        setRefreshing(false)
      })
  }, [])

  return { limits, refreshing, refresh }
}

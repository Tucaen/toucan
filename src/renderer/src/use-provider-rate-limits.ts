import { useEffect, useState } from 'react'
import type { ProviderRateLimits } from '../../shared/agent'

/** The main process caches these reads, so this cadence only decides display freshness. */
const PROVIDER_USAGE_POLL_MS = 60_000

/** Owns the single account-wide usage poll shared by every conversation node. */
export function useProviderRateLimits(): ProviderRateLimits {
  const [rateLimits, setRateLimits] = useState<ProviderRateLimits>({})

  useEffect(() => {
    let active = true
    const refresh = async (): Promise<void> => {
      const limits = await window.usageApi.rateLimits().catch(() => null)
      if (active && limits) setRateLimits(limits)
    }
    void refresh()
    const interval = setInterval(() => void refresh(), PROVIDER_USAGE_POLL_MS)
    return () => {
      active = false
      clearInterval(interval)
    }
  }, [])

  return rateLimits
}

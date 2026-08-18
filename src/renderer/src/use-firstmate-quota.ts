import { useEffect, useState } from 'react'
import type { AgentProvider } from '../../shared/agent'
import type { FirstMateQuotaStatus } from '../../shared/firstmate'

/**
 * This is an account-wide, minutes-scale limit rather than a fast-changing per-token signal, so a
 * multi-minute poll interval is plenty and keeps every open panel/node from hammering `quota-axi`.
 */
const QUOTA_POLL_INTERVAL_MS = 2 * 60_000

/** Polls the account's hourly/weekly usage-limit status for one provider, permanently rather than on demand. */
export function useFirstMateQuota(provider: AgentProvider, enabled: boolean): FirstMateQuotaStatus | null {
  const [quota, setQuota] = useState<FirstMateQuotaStatus | null>(null)

  useEffect(() => {
    if (!enabled) {
      setQuota(null)
      return
    }
    let active = true
    const refresh = (): void => {
      void window.firstMateApi.quotaStatus(provider).then((status) => {
        if (active) setQuota(status)
      })
    }
    refresh()
    const timer = window.setInterval(refresh, QUOTA_POLL_INTERVAL_MS)
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [enabled, provider])

  return quota
}

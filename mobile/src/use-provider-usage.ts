import { useEffect, useState } from 'react'
import { keptAsStale, type AgentProvider, type ProviderUsageReport } from '../../src/shared/agent'
import { PROVIDER_USAGE_POLL_MS } from '../../src/shared/remote-usage'
import { fetchProviderUsage } from './remote-client'
import type { SavedHost } from './hosts'

/**
 * The phone's one account-usage poll (issue #195), owned by the shell rather than by a screen.
 *
 * It lives above the router for the same reason the desktop's lives above the canvas: two surfaces
 * want the answer - the chat list's provider chips and a conversation's own usage row, where the
 * nearest account window is one of the three things the bar shows - and two polls would read the
 * same host twice a minute to draw the same number twice.
 *
 * Three rules it holds:
 *
 * - **One host at a time, and switching forgets.** The poll is keyed on the host's identity and its
 *   token, so the moment the reader switches PCs or re-pairs one, the previous figures are gone
 *   rather than relabelled. Account usage belongs to the account behind a host; showing the work
 *   PC's remaining 5h window under the private PC's name is worse than showing nothing.
 * - **A failed poll keeps the last reading and says so.** The host already marks a reading it kept
 *   through a failed *provider* read; a request that never reached the host at all has to be marked
 *   here, or an offline PC quietly presents a frozen number as the present. `keptAsStale` is the
 *   shared rule both sides of that boundary use.
 * - **It never unpairs anything.** A `401` here stops nothing but this reading: the workspace poll
 *   owns re-pairing, it runs twenty times more often, and a usage request racing it into the
 *   unauthorized path would only be a second route to a screen the reader is already on their way
 *   to.
 */
export function useProviderUsage(host: SavedHost | null): ProviderUsageReport {
  const [report, setReport] = useState<ProviderUsageReport>({})
  // Depended on by value rather than by object identity: the directory hands out fresh host objects
  // as it re-renders, and restarting the poll on each of those would turn a 60s cadence into
  // whatever the render rate happens to be - against someone's home PC.
  const origin = host?.origin ?? null
  const token = host?.token ?? null

  useEffect(() => {
    // Cleared on the way in, not on the way out: a switch must not leave the previous host's
    // numbers on screen for the instant before the new host's first poll answers.
    setReport({})
    if (origin === null || token === null) return
    let cancelled = false
    const controller = new AbortController()

    const poll = async (): Promise<void> => {
      const result = await fetchProviderUsage({ origin, token }, controller.signal)
      if (cancelled) return
      if (result.ok) {
        setReport(result.value)
        return
      }
      setReport((current) => {
        const kept: ProviderUsageReport = {}
        for (const provider of Object.keys(current) as AgentProvider[]) {
          const entry = keptAsStale(current[provider])
          if (entry) kept[provider] = entry
        }
        return kept
      })
    }

    void poll()
    const timer = window.setInterval(() => void poll(), PROVIDER_USAGE_POLL_MS)
    return () => {
      cancelled = true
      controller.abort()
      window.clearInterval(timer)
    }
  }, [origin, token])

  return report
}

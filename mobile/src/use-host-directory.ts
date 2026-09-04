import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  addHost,
  newHostId,
  removeHost as removeFromDirectory,
  renameHost as renameInDirectory,
  revokedHostToken,
  selectedHost,
  selectHost as selectInDirectory,
  type HostDirectory,
  type HostDraft,
  type SavedHost
} from './hosts'
import {
  appliedHostProbe,
  notedHostOutcome,
  hostProbeDelayMs,
  hostStatus,
  prunedHostStatuses,
  unpairedHostStatus,
  type HostProbe,
  type HostStatuses
} from './host-status'
import { rememberHostDirectory, storedHostDirectory, verifyHost } from './remote-client'

/**
 * The saved hosts and what is known about each one's reachability, owned in one place because both
 * halves are app-wide: every screen is parameterized by the selected host, and the switcher has to
 * report the ones that are *not* selected - a killed PC has to show as offline while the reader
 * keeps working against the other.
 *
 * Every mutation goes through here and is persisted immediately, so there is no window in which the
 * list on screen and the list on disk disagree. The probing is a per-host timer chain rather than
 * one interval over the list: hosts fail independently, so they retry independently, and the
 * schedule is `hostProbeDelayMs`'s decision rather than this hook's.
 */
export interface HostDirectoryController {
  directory: HostDirectory
  /** The host every screen is addressed to; null only when nothing is paired yet. */
  host: SavedHost | null
  statuses: HostStatuses
  /** Adds or re-pairs (same origin means same host) and selects it. */
  pairHost(draft: HostDraft): void
  renameHost(id: string, name: string): void
  removeHost(id: string): void
  selectHost(id: string): void
  /** A host answered `401`. Only that host drops into re-pairing. */
  revokeHost(id: string): void
  /**
   * Folds an outcome a screen already learned into the shared map, so the workspace poll's verdict
   * on the selected host is the same fact the switcher reports rather than a second opinion.
   */
  reportProbe(id: string, probe: HostProbe): void
}

export function useHostDirectory(): HostDirectoryController {
  const [directory, setDirectory] = useState<HostDirectory>(() => storedHostDirectory())
  const [statuses, setStatuses] = useState<HostStatuses>({})

  /**
   * Every mutation is one of the pure list operations, applied and persisted here. Wrapped once
   * rather than at five call sites, so no path that changes the list can forget to save it - and an
   * operation that decided nothing changed (a rename to blank, a selection of a host that is gone)
   * writes nothing at all.
   */
  const mutate = useCallback((apply: (current: HostDirectory) => HostDirectory) => {
    setDirectory((current) => {
      const next = apply(current)
      if (next === current) return current
      rememberHostDirectory(next)
      return next
    })
  }, [])

  const pairHost = useCallback(
    (draft: HostDraft) => mutate((current) => addHost(current, draft, newHostId())),
    [mutate]
  )
  const renameHost = useCallback(
    (id: string, name: string) => mutate((current) => renameInDirectory(current, id, name)),
    [mutate]
  )
  const removeHost = useCallback((id: string) => mutate((current) => removeFromDirectory(current, id)), [mutate])
  const selectHost = useCallback((id: string) => mutate((current) => selectInDirectory(current, id)), [mutate])
  const revokeHost = useCallback((id: string) => mutate((current) => revokedHostToken(current, id)), [mutate])

  /**
   * A `401` from anywhere is the same fact wherever it was seen: this host's token is no longer
   * accepted. Recording it on the *list* rather than only in the status map is what makes the
   * re-pair state real for a host nobody is looking at - otherwise a background host would show as
   * needing pairing in the switcher while the directory still held a dead token, and switching to
   * it would open a chat list that could only fail.
   */
  const reportProbe = useCallback(
    (id: string, probe: HostProbe) => {
      setStatuses((current) => notedHostOutcome(current, id, probe, Date.now()))
      if (!probe.ok && 'unauthorized' in probe) revokeHost(id)
    },
    [revokeHost]
  )

  // A forgotten host must stop reporting, or the switcher would keep a dot for something that is
  // no longer in the list and the map would grow for the life of the tab.
  useEffect(() => {
    setStatuses((current) => {
      const pruned = prunedHostStatuses(current, directory.hosts)
      return Object.keys(pruned).length === Object.keys(current).length ? current : pruned
    })
  }, [directory.hosts])

  // The schedule reads the newest committed statuses without those statuses being a dependency of
  // the loop that writes them, which is what keeps one probe's outcome from restarting every chain.
  const statusesRef = useRef(statuses)
  statusesRef.current = statuses

  /**
   * What the probe loop is keyed on: the hosts it has to reach, and nothing else about the
   * directory. A rename or a switch changes `directory.hosts` by identity, and depending on that
   * would restart every host's schedule - resetting a backoff that was deliberately backing off.
   * Re-addressing or re-pairing a host *does* belong here, and it is what makes a pasted token
   * probe immediately rather than wait out the previous schedule.
   */
  const probeSignature = directory.hosts.map((host) => `${host.id}${host.origin}${host.token}`).join('\n')
  const hostsRef = useRef(directory.hosts)
  hostsRef.current = directory.hosts

  /** One timer chain per host, because hosts fail independently and so must retry independently. */
  useEffect(() => {
    let disposed = false
    const timers: number[] = []
    const controller = new AbortController()

    for (const host of hostsRef.current) {
      // Nothing to ask a host that has no token: its state is already known, and probing would
      // only collect a `401` the reader has been shown.
      if (host.token.length === 0) {
        setStatuses((current) => unpairedHostStatus(current, host.id, Date.now()))
        continue
      }
      const schedule = (): void => {
        if (disposed) return
        const delay = hostProbeDelayMs(hostStatus(statusesRef.current, host.id))
        timers.push(window.setTimeout(() => void run(), delay))
      }
      const run = async (): Promise<void> => {
        if (disposed) return
        const result = await verifyHost(host, controller.signal)
        if (disposed) return
        const probe: HostProbe = result.ok
          ? { ok: true }
          : result.kind === 'unauthorized'
            ? { ok: false, unauthorized: true }
            : { ok: false, message: result.message }
        // This schedule's own probe, so it is the one fold that paces the retry.
        setStatuses((current) => appliedHostProbe(current, host.id, probe, Date.now()))
        if (!probe.ok && 'unauthorized' in probe) revokeHost(host.id)
        schedule()
      }
      void run()
    }

    return () => {
      disposed = true
      controller.abort()
      for (const timer of timers) window.clearTimeout(timer)
    }
  }, [probeSignature, revokeHost])

  const host = useMemo(() => selectedHost(directory), [directory])

  return {
    directory,
    host,
    statuses,
    pairHost,
    renameHost,
    removeHost,
    selectHost,
    revokeHost,
    reportProbe
  }
}

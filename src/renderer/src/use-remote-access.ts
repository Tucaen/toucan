import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  deriveRemoteWorkspaceProjection,
  type RemoteAccessSettings,
  type RemoteAccessState,
  type RemoteWorkspaceSource
} from '../../shared/remote-access'
import type { TerminalNodeStatus } from '../../shared/terminal'

/**
 * The renderer's one owner of remote access. It holds no policy - the host decides whether a
 * listener comes up and what the pairing token is - and does exactly two jobs: it keeps the
 * settings dialog looking at the host's real state, and it publishes the canvas projection a
 * paired phone lists.
 *
 * Publishing is deduplicated on purpose. The workspace snapshot is rebuilt on every drag frame
 * and every keystroke in a composer draft, none of which changes what a phone shows, so the
 * projection is serialized and compared before it is sent. Without that, dragging a node would
 * push hundreds of identical projections across the privilege seam.
 */
export interface RemoteAccessController {
  /** Null until the host has answered; the dialog shows a loading state rather than defaults. */
  state: RemoteAccessState | null
  busy: boolean
  applySettings(settings: RemoteAccessSettings): Promise<void>
  regenerateToken(): Promise<void>
}

export function useRemoteAccess(
  source: RemoteWorkspaceSource,
  statuses: Readonly<Record<string, TerminalNodeStatus>>
): RemoteAccessController {
  const [state, setState] = useState<RemoteAccessState | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    void window.remoteApi.state().then((next) => {
      if (!cancelled) setState(next)
    })
    // The listener can also change without being asked - a bind that fails later, a port that
    // stops being available - so the dialog subscribes instead of polling.
    const stop = window.remoteApi.onStateChange(setState)
    return () => {
      cancelled = true
      stop()
    }
  }, [])

  const projection = useMemo(() => deriveRemoteWorkspaceProjection(source, statuses), [source, statuses])
  const published = useRef<string | null>(null)

  useEffect(() => {
    const serialized = JSON.stringify(projection)
    if (published.current === serialized) return
    published.current = serialized
    window.remoteApi.publishWorkspace(projection)
  }, [projection])

  const run = useCallback(async (operation: () => Promise<RemoteAccessState>): Promise<void> => {
    setBusy(true)
    try {
      setState(await operation())
    } finally {
      setBusy(false)
    }
  }, [])

  const applySettings = useCallback(
    (settings: RemoteAccessSettings) => run(() => window.remoteApi.applySettings(settings)),
    [run]
  )
  const regenerateToken = useCallback(() => run(() => window.remoteApi.regenerateToken()), [run])

  return { state, busy, applySettings, regenerateToken }
}

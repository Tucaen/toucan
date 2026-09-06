import { useCallback, useEffect, useState } from 'react'
import type { AppUpdateSnapshot } from '../../shared/app-update'

/**
 * The renderer's one owner of updating. It holds no policy: the host decides whether this run may
 * check at all, whether a package exists and whether a restart installs one. This only keeps the
 * header looking at the host's real answer and remembers one thing the host cannot know - whether
 * the user asked for the check that is running, which is what decides if a failure is worth
 * showing them.
 */
export interface AppUpdateController {
  /** Null until the host has answered; the header shows nothing rather than a guessed version. */
  snapshot: AppUpdateSnapshot | null
  busy: boolean
  /** Whether a failure should be surfaced: only the check the user asked for reports back. */
  announceError: boolean
  check(): void
  restart(): void
}

export function useAppUpdate(): AppUpdateController {
  const [snapshot, setSnapshot] = useState<AppUpdateSnapshot | null>(null)
  const [busy, setBusy] = useState(false)
  const [announceError, setAnnounceError] = useState(false)

  useEffect(() => {
    let cancelled = false
    void window.appUpdateApi.state().then((next) => {
      if (!cancelled) setSnapshot(next)
    })
    // A download lands minutes after any question was asked, so the header subscribes. Anything
    // arriving this way is news nobody asked for, so it also retires a reported failure: the
    // alternative is one failed manual check making every later background failure loud forever.
    const stop = window.appUpdateApi.onChange((next) => {
      setAnnounceError(false)
      setSnapshot(next)
    })
    return () => {
      cancelled = true
      stop()
    }
  }, [])

  const check = useCallback(() => {
    setAnnounceError(false)
    setBusy(true)
    void window.appUpdateApi
      .check()
      .then((settled) => {
        setSnapshot(settled)
        // Only the check the user just asked for earns a visible failure, and only this one.
        setAnnounceError(settled.status.phase === 'error')
      })
      .finally(() => setBusy(false))
  }, [])

  // The host quits the process on success, so there is nothing to do afterwards on that path; a
  // refusal means the package went away, and the next change event will say so.
  const restart = useCallback(() => void window.appUpdateApi.restart(), [])

  return {
    snapshot,
    busy,
    announceError,
    check,
    restart
  }
}

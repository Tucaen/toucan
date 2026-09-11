import { useEffect, useRef, useState } from 'react'

/** How long a confirmation cue is held; long enough to notice, short enough not to nag. */
export const REFRESH_FLASH_MS = 1200

export interface RefreshFlashInput {
  /** Whether a refresh was in flight when the surface last rendered. */
  wasRefreshing: boolean
  refreshing: boolean
  /** True when the refresh fell back to the reading already on screen instead of replacing it. */
  stale: boolean
}

/**
 * Whether a refresh just landed with something worth confirming. A surface whose numbers rarely
 * change between two refreshes has nothing else to show for a click, so this is what separates
 * "it worked and nothing moved" from "the click did nothing" - and a refresh that only fell back to
 * the reading already on screen is deliberately not confirmed, because the stale marking says the
 * opposite and two contradicting signals are worse than one.
 */
export function confirmsRefresh(input: RefreshFlashInput): boolean {
  return input.wasRefreshing && !input.refreshing && !input.stale
}

/** Holds {@link confirmsRefresh} true for {@link REFRESH_FLASH_MS}, then lets the surface settle. */
export function useRefreshFlash(refreshing: boolean, stale: boolean): boolean {
  const [flashing, setFlashing] = useState(false)
  const wasRefreshing = useRef(refreshing)

  useEffect(() => {
    const confirmed = confirmsRefresh({ wasRefreshing: wasRefreshing.current, refreshing, stale })
    wasRefreshing.current = refreshing
    // Dropping the cue on the way in matters as much as raising it: a second click inside the
    // window has to clear it first, or the surface never leaves the state that drives the cue and
    // the second refresh lands with nothing to show. It also keeps a cue from outliving the run
    // that raised it when the reading turns stale mid-flash.
    if (!confirmed) {
      setFlashing(false)
      return undefined
    }
    setFlashing(true)
    const timer = setTimeout(() => setFlashing(false), REFRESH_FLASH_MS)
    return () => clearTimeout(timer)
  }, [refreshing, stale])

  return flashing
}

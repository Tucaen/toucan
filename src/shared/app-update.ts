/**
 * What "Toucan can update itself" means, expressed once for the host, the bridge and the UI.
 *
 * The host owns the mechanism - electron-updater talks to the public releases feed - but the
 * *state* an update run passes through is a decision, not a side effect, so it lives here as a
 * fold over the events that mechanism emits. Two rules are the whole reason this is a module and
 * not a handful of booleans in the main process:
 *
 * - A downloaded package is sticky. Once the installer is on disk, restarting installs it, and no
 *   later check - one that fails, one that finds nothing because the feed briefly 404s - may take
 *   the "Restart to update" offer away from a user who can still act on it.
 * - "Found nothing" and "have not looked" are different answers. A manual check has to be able to
 *   say "you are on the latest version" instead of silently returning to the state it started in.
 *
 * Nothing here throws: a network failure is a value, because an update check the user did not ask
 * for must never interrupt a running session.
 */

export type AppUpdateStatus =
  | { phase: 'idle' }
  | { phase: 'checking' }
  | { phase: 'up-to-date' }
  | { phase: 'available'; version: string }
  | { phase: 'downloaded'; version: string }
  | { phase: 'error'; message: string }

export type AppUpdateEvent =
  | { type: 'check-started' }
  | { type: 'available'; version: string }
  | { type: 'not-available' }
  | { type: 'downloaded'; version: string }
  | { type: 'error'; message: string }

export const APP_UPDATE_IDLE: AppUpdateStatus = { phase: 'idle' }

export function nextAppUpdateStatus(status: AppUpdateStatus, event: AppUpdateEvent): AppUpdateStatus {
  // Only a newer package displaces one already waiting; everything else is noise about a state the
  // user has already been offered a way out of.
  if (status.phase === 'downloaded')
    return event.type === 'downloaded' && event.version !== status.version
      ? { phase: 'downloaded', version: event.version }
      : status
  switch (event.type) {
    case 'check-started':
      return { phase: 'checking' }
    case 'available':
      return { phase: 'available', version: event.version }
    case 'not-available':
      return { phase: 'up-to-date' }
    case 'downloaded':
      return { phase: 'downloaded', version: event.version }
    case 'error':
      return { phase: 'error', message: event.message }
  }
}

/** Everything the UI needs to talk about updates, including the version it is currently running. */
export interface AppUpdateSnapshot {
  currentVersion: string
  status: AppUpdateStatus
}

/**
 * Why this run must not talk to the update feed, or null if it may.
 *
 * A dev run has no installer to replace and its version is whatever `package.json` says, so a
 * check would offer to "update" a working tree. A portable exe was copied somewhere by hand and
 * has no NSIS install to write over; electron-updater cannot service it, and asking would only
 * produce an error the user can do nothing about.
 */
export function appUpdateSkipReason(runtime: {
  packaged: boolean
  environment: Readonly<Record<string, string | undefined>>
}): 'development' | 'portable' | null {
  if (!runtime.packaged) return 'development'
  if (runtime.environment.PORTABLE_EXECUTABLE_DIR) return 'portable'
  return null
}

/** The update seam as the renderer sees it. Every verdict on it is the host's. */
export interface AppUpdateApi {
  state(): Promise<AppUpdateSnapshot>
  /** Asks for a check now. Resolves with the snapshot the request settled on; never rejects. */
  check(): Promise<AppUpdateSnapshot>
  /** Restarts into the downloaded package. False when there is nothing to restart into. */
  restart(): Promise<boolean>
  onChange(callback: (snapshot: AppUpdateSnapshot) => void): () => void
}

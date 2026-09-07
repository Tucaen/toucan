import {
  APP_UPDATE_IDLE,
  appUpdateSkipReason,
  nextAppUpdateStatus,
  type AppUpdateEvent,
  type AppUpdateSnapshot
} from '../shared/app-update'
import { errorMessage } from '../shared/text'

/**
 * The host's owner of self-updating. It is the only place that talks to electron-updater, and it
 * talks to it through `AppUpdaterPort` rather than importing it, so the whole lifecycle - startup
 * check, manual check, restart - is decided in tests without a packaged app or a release feed.
 *
 * Two things are deliberately *not* here. The state transitions are `nextAppUpdateStatus`'s, in
 * shared, because the renderer reasons about the same states. And whether an update may be looked
 * for at all is `appUpdateSkipReason`'s: a dev run and a portable exe are asked once, at
 * construction, and a skipped updater never subscribes, so no stray event from the singleton
 * electron-updater exposes can move a state the user was never offered.
 *
 * Nothing in here rejects or throws. An update check is background work the user did not ask for;
 * a dead network must cost a log line, not an unhandled rejection in the main process.
 */

/** The slice of electron-updater's `autoUpdater` this module drives. */
export interface AppUpdaterPort {
  /** Both are set by `createAppUpdater`; see the assignments there for why. */
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  on(event: string, listener: (payload?: unknown) => void): void
  checkForUpdates(): Promise<unknown>
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void
}

export interface AppUpdater {
  snapshot(): AppUpdateSnapshot
  /**
   * Looks for an update, at startup and whenever the user asks. Resolves with the snapshot the
   * request settled on and never rejects; who asked is the renderer's business, not the host's.
   */
  check(): Promise<AppUpdateSnapshot>
  /** Restarts into the downloaded package. False when there is nothing to restart into. */
  quitAndInstall(): boolean
  onChange(listener: (snapshot: AppUpdateSnapshot) => void): () => void
}

/** electron-updater's `UpdateInfo`, narrowed to the one field this module trusts. */
function releaseVersion(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null
  const version = (payload as { version?: unknown }).version
  return typeof version === 'string' && version.length > 0 ? version : null
}

export function createAppUpdater(options: {
  updater: AppUpdaterPort
  currentVersion: string
  packaged: boolean
  environment: Readonly<Record<string, string | undefined>>
  log: (message: string) => void
}): AppUpdater {
  const { updater, currentVersion, environment, packaged, log } = options
  const skipped = appUpdateSkipReason({ packaged, environment })
  let status = APP_UPDATE_IDLE
  const listeners = new Set<(snapshot: AppUpdateSnapshot) => void>()

  const snapshot = (): AppUpdateSnapshot => ({ currentVersion, status })

  const apply = (event: AppUpdateEvent): void => {
    const next = nextAppUpdateStatus(status, event)
    if (next === status) return
    status = next
    const current = snapshot()
    for (const listener of listeners) listener(current)
  }

  if (skipped) {
    log(`Updates are off for this run (${skipped}).`)
  } else {
    // Fetched as soon as one is found, so "Restart to update" is an offer the user can take
    // immediately rather than the start of a download they then wait on.
    updater.autoDownload = true
    // No silent install on quit: a session Toucan is hosting can outlive the window the user just
    // closed, so replacing the binary underneath it is the user's call and nobody else's.
    updater.autoInstallOnAppQuit = false
    updater.on('update-available', (payload) => {
      const version = releaseVersion(payload)
      if (version) apply({ type: 'available', version })
    })
    updater.on('update-not-available', () => apply({ type: 'not-available' }))
    updater.on('update-downloaded', (payload) => {
      const version = releaseVersion(payload)
      if (version) apply({ type: 'downloaded', version })
    })
    // The updater reports transport failures here as well as through the check's rejection, and
    // which one arrives depends on when the request died. Both land on the same status.
    updater.on('error', (payload) => {
      const message = errorMessage(payload)
      log(`Update check failed: ${message}`)
      apply({ type: 'error', message })
    })
  }

  const check = async (): Promise<AppUpdateSnapshot> => {
    if (skipped) return snapshot()
    apply({ type: 'check-started' })
    try {
      await updater.checkForUpdates()
    } catch (error) {
      const message = errorMessage(error)
      log(`Update check failed: ${message}`)
      apply({ type: 'error', message })
    }
    return snapshot()
  }

  return {
    snapshot,
    check,
    quitAndInstall: () => {
      if (status.phase !== 'downloaded') return false
      // Silent (`/S`) so the assisted installer skips its wizard and reuses the recorded install
      // directory, and force-run because a silent assisted install relaunches the app only when
      // told to. Together an update is what the user expects: the window closes, the new version
      // opens. Without both, every update replays the first-install wizard.
      updater.quitAndInstall(true, true)
      return true
    },
    onChange: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
}

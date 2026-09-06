import { Download, RefreshCw } from 'lucide-react'
import type { AppUpdateSnapshot, AppUpdateStatus } from '../../shared/app-update'

/**
 * Toucan's entire update surface, and deliberately the smallest one that works: the running
 * version, always visible, which is also the button that asks for a check and the button that
 * restarts into a package once one is waiting.
 *
 * It is a chip and not a banner or a dialog on purpose. An update arriving while an agent is
 * mid-turn must not take the canvas, move it, or steal focus - the user decides when to restart,
 * and until they do, nothing about Toucan changes.
 *
 * Failures are shown only when the user asked. A startup check against a tethered phone fails
 * constantly and means nothing; the same failure right after a click has to be reported, or the
 * click looks broken.
 */
export function AppUpdateChip({
  snapshot,
  announceError,
  busy,
  onCheck,
  onRestart
}: {
  /** Null until the host has answered. */
  snapshot: AppUpdateSnapshot | null
  announceError: boolean
  busy: boolean
  onCheck(): void
  onRestart(): void
}): JSX.Element | null {
  if (!snapshot) return null
  const { currentVersion, status } = snapshot

  if (status.phase === 'downloaded')
    return (
      <button
        type="button"
        className="header-app-update"
        data-phase="downloaded"
        title={`Toucan ${status.version} is downloaded. Restarting installs it; running sessions are not interrupted until you do.`}
        onClick={onRestart}
      >
        <Download aria-hidden="true" />
        Restart to update
      </button>
    )

  // A failure nobody asked for is not a state the header has. It is suppressed once, and both what
  // the chip reads as and what it says come from that one decision rather than drifting apart.
  const suppressed = status.phase === 'error' && !announceError
  const resting = `Toucan ${currentVersion} – Check for updates`

  return (
    <button
      type="button"
      className="header-app-update"
      data-phase={suppressed ? 'idle' : status.phase}
      title={suppressed ? resting : describe(status, currentVersion, resting)}
      disabled={busy}
      onClick={onCheck}
    >
      <RefreshCw aria-hidden="true" />
      {currentVersion}
    </button>
  )
}

function describe(status: Exclude<AppUpdateStatus, { phase: 'downloaded' }>, version: string, resting: string): string {
  switch (status.phase) {
    case 'checking':
      return 'Checking for updates…'
    case 'available':
      return `Toucan ${status.version} is downloading…`
    case 'up-to-date':
      return `Toucan ${version} is the latest version.`
    case 'error':
      return `Update check failed: ${status.message}`
    default:
      return resting
  }
}

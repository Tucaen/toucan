import type { AppUpdateSnapshot } from '../../src/shared/app-update'
import type { RemoteRestartWarning } from '../../src/shared/remote-app-update'

/**
 * What the phone's update card says and offers (#5). The state is the host's snapshot; the only
 * state the phone adds is its own restart, because "I asked the desktop to restart and it has gone
 * quiet" is something only the asking device knows.
 */

/** The restart as this phone has driven it. */
export type PhoneRestart =
  | { stage: 'none' }
  /** The host named busy sessions; nothing happens until the reader confirms or cancels. */
  | { stage: 'confirming'; warning: RemoteRestartWarning }
  /**
   * The host accepted and is going away. `hostGone` records that a poll has since failed, so a host
   * that answers again is one that came back rather than one that never left.
   */
  | { stage: 'restarting'; from: string; to: string; since: number; hostGone: boolean }

export const NO_RESTART: PhoneRestart = { stage: 'none' }

/**
 * How long a host may keep answering on its old version before the phone stops saying "restarting".
 * The installer replaces the app in seconds; a host still up and unchanged after this did not restart.
 */
export const RESTART_STALL_MS = 120_000

/** Polled briskly while something is moving, rarely while nothing is. */
export const APP_UPDATE_ACTIVE_POLL_MS = 3_000
export const APP_UPDATE_IDLE_POLL_MS = 30_000

export interface AppUpdateLine {
  text: string
  /** The card's one button, or none while a check or download is under way. */
  action: { kind: 'check' | 'restart'; label: string } | null
}

/**
 * The card's line for a snapshot. Like the desktop chip, a failure nobody on this phone asked for
 * reads as the resting state: a startup check against a flaky network fails constantly and means
 * nothing, while the same failure right after a tap has to be shown or the tap looks broken.
 */
export function describeAppUpdate(snapshot: AppUpdateSnapshot, announceError: boolean): AppUpdateLine {
  const { currentVersion, status } = snapshot
  const check = { kind: 'check' as const, label: 'Check for updates' }
  switch (status.phase) {
    case 'checking':
      return { text: 'Checking for updates…', action: null }
    case 'available':
      return { text: `Downloading Toucan ${status.version}…`, action: null }
    case 'downloaded':
      return {
        text: `Toucan ${status.version} is downloaded (running ${currentVersion}).`,
        action: { kind: 'restart', label: 'Restart to update' }
      }
    case 'up-to-date':
      return { text: `Toucan ${currentVersion} is the latest version.`, action: check }
    case 'error':
      return announceError
        ? { text: `Update check failed: ${status.message}`, action: check }
        : { text: `Toucan ${currentVersion}`, action: check }
    default:
      return { text: `Toucan ${currentVersion}`, action: check }
  }
}

export function isAppUpdateMoving(snapshot: AppUpdateSnapshot | null, restart: PhoneRestart): boolean {
  if (restart.stage === 'restarting') return true
  return snapshot?.status.phase === 'checking' || snapshot?.status.phase === 'available'
}

/**
 * What one poll means for a restart in progress. The host coming back - on a new version, or after
 * having gone away at all - is the restart done; a host that never left and still runs the old
 * version after `RESTART_STALL_MS` did not restart, and the phone says so instead of waiting forever.
 */
export function followRestart(
  restart: Extract<PhoneRestart, { stage: 'restarting' }>,
  poll: { ok: true; snapshot: AppUpdateSnapshot } | { ok: false },
  now: number
): { restart: PhoneRestart; notice: string | null; problem: string | null } {
  if (!poll.ok) return { restart: { ...restart, hostGone: true }, notice: null, problem: null }
  const version = poll.snapshot.currentVersion
  if (version !== restart.from) return { restart: NO_RESTART, notice: `Updated to Toucan ${version}.`, problem: null }
  if (restart.hostGone)
    return { restart: NO_RESTART, notice: null, problem: `The desktop restarted but is still on Toucan ${version}.` }
  if (now - restart.since > RESTART_STALL_MS)
    return {
      restart: NO_RESTART,
      notice: null,
      problem: 'The desktop has not restarted. Try again from here or on the desktop.'
    }
  return { restart, notice: null, problem: null }
}

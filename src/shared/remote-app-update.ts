import type { AppUpdateSnapshot, AppUpdateStatus } from './app-update'
import { isRecord } from './record'

/**
 * Updating the desktop from a phone (#5): the same check and the same restart the header's version
 * chip offers, over the remote surface.
 *
 * The phone never holds update state of its own. `GET /api/app-update` is the host's
 * `AppUpdateSnapshot` verbatim, `POST /api/app-update/check` runs the host's own check and answers
 * with the snapshot it settled on, and `POST /api/app-update/restart` restarts into the package the
 * host has already downloaded.
 *
 * The restart is where the phone differs from the desktop, and only in who is asked. A restart
 * kills every hosted session, so the desktop asks first when one is working or has background
 * tasks - with a modal on the desktop, which a reader holding the phone may be nowhere near. The
 * phone therefore asks *without* `confirmed` first: an idle host restarts at once, a busy one
 * answers with the warning the desktop would have shown, and the phone shows it and repeats the
 * request with `confirmed: true`. A confirmed restart never waits on the desktop's modal.
 */

/** What a restart would stop, in the desktop dialog's own words (`describeQuitRisk`). */
export interface RemoteRestartWarning {
  title: string
  message: string
  /** The consequence and the named sessions, one per line; read with line breaks kept. */
  detail: string
  /** The proceed button's label; the other choice is always Cancel. */
  proceedLabel: string
}

/**
 * The restart's answer. `restarting` means the host has answered and is about to go away, so what
 * follows is a connection lost, not a failure. `confirm` means nothing happened yet: sessions are
 * busy and the reader has to say so first.
 */
export type RemoteRestartReply =
  { restarting: true } | { restarting: false; confirm: RemoteRestartWarning } | { restarting: false; error: string }

/** The restart request is one optional flag; anything bigger is not one. */
export const REMOTE_APP_UPDATE_BODY_LIMIT = 1024

/** An empty body is an unconfirmed restart; a body that is not the flag is refused. */
export function parseRemoteRestartRequest(body: string): { confirmed: boolean } | null {
  if (body.trim().length === 0) return { confirmed: false }
  let value: unknown
  try {
    value = JSON.parse(body)
  } catch {
    return null
  }
  if (!isRecord(value)) return null
  const confirmed = value.confirmed
  if (confirmed !== undefined && typeof confirmed !== 'boolean') return null
  return { confirmed: confirmed === true }
}

const text = (value: unknown): value is string => typeof value === 'string'
const named = (value: unknown): value is string => text(value) && value.length > 0

function parseStatus(value: unknown): AppUpdateStatus | null {
  if (!isRecord(value)) return null
  switch (value.phase) {
    case 'idle':
    case 'checking':
    case 'up-to-date':
      return { phase: value.phase }
    case 'available':
    case 'downloaded':
      return named(value.version) ? { phase: value.phase, version: value.version } : null
    case 'error':
      return text(value.message) ? { phase: 'error', message: value.message } : null
    default:
      return null
  }
}

/** Parsed, not cast: the phone offers a restart on the strength of this, so a damaged one is none. */
export function parseAppUpdateSnapshot(value: unknown): AppUpdateSnapshot | null {
  if (!isRecord(value) || !named(value.currentVersion)) return null
  const status = parseStatus(value.status)
  return status ? { currentVersion: value.currentVersion, status } : null
}

export function parseRemoteRestartReply(value: unknown): RemoteRestartReply | null {
  if (!isRecord(value)) return null
  if (value.restarting === true) return { restarting: true }
  const confirm = value.confirm
  if (isRecord(confirm)) {
    const { title, message, detail, proceedLabel } = confirm
    if (text(title) && text(message) && text(detail) && named(proceedLabel))
      return { restarting: false, confirm: { title, message, detail, proceedLabel } }
    return null
  }
  return text(value.error) ? { restarting: false, error: value.error } : null
}

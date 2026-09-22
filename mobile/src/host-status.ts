import type { SavedHost } from './hosts'

/**
 * What the phone knows about whether each saved host is actually there.
 *
 * This exists because "offline" is a per-host fact on a client that holds several, and because the
 * app has to stay usable while one of them is down: a PC that rebooted, a Toucan that was quit, a
 * tailnet that has not reconnected yet. So reachability is a map keyed by host id that every
 * surface reads - the switcher's dots, the header's indicator - rather than a failure the screen
 * currently rendering happens to be holding.
 *
 * The retry schedule lives here for the same reason it lives in `chat-connection.ts` for sockets:
 * it is a decision, not a timer. A host that just went offline is probed quickly (a locked phone
 * and a switched network both look like an outage for a second), then progressively more slowly,
 * bounded so a PC that is genuinely off is still noticed coming back within seconds rather than
 * hammered or given up on.
 */

export type HostReachability =
  /** Not probed yet. Renders as neither online nor offline, because it is neither. */
  | 'unknown'
  | 'online'
  | 'offline'
  /** Reached, and it refused the token: this host needs re-pairing and nothing else does. */
  | 'unpaired'

export interface HostStatus {
  reachability: HostReachability
  /** The host's own wording for an outage, kept so an error is reported rather than a colour. */
  message: string | null
  /** Consecutive failures, which is what paces the retry. Reset by any success. */
  attempt: number
  checkedAt: number
}

export type HostStatuses = Record<string, HostStatus>

/** @internal exported for tests */
export const UNKNOWN_HOST_STATUS: HostStatus = {
  reachability: 'unknown',
  message: null,
  attempt: 0,
  checkedAt: 0
}

/** One probe's outcome, in the only three terms this module distinguishes. */
export type HostProbe = { ok: true } | { ok: false; unauthorized: true } | { ok: false; message: string }

export function hostStatus(statuses: HostStatuses, id: string): HostStatus {
  return statuses[id] ?? UNKNOWN_HOST_STATUS
}

/**
 * The status to *show* for a saved host, which is not always the last probe's.
 *
 * A host with no token needs pairing whatever the last probe said, and the difference is visible:
 * a token revoked a moment ago leaves a stale `online` in the map until the loop catches up, and
 * "Online" is the one thing that host is not usefully doing. The list is the authority on the
 * token, so it outranks the probe - and every surface reads this rather than deciding for itself,
 * so a host cannot present as two different states on two screens.
 */
export function effectiveHostStatus(host: SavedHost, statuses: HostStatuses): HostStatus {
  const status = hostStatus(statuses, host.id)
  if (host.token.length > 0) return status
  return status.reachability === 'unpaired' ? status : { ...status, reachability: 'unpaired', message: null }
}

/**
 * Folds in the outcome of a probe *this schedule* performed. `attempt` counts consecutive
 * unreachable results, and it is the only thing that paces the retry - so only the schedule's own
 * probes may move it. A refused token is not an outage, so it neither escalates nor resets the
 * count: the host is up, and re-probing it fast would only repeat a `401` the reader has been told.
 */
export function appliedHostProbe(statuses: HostStatuses, id: string, probe: HostProbe, now: number): HostStatuses {
  return foldProbe(statuses, id, probe, now, true)
}

/**
 * Folds in a verdict some *other* request already produced - the chat list's workspace poll, which
 * hits the selected host far more often than any heartbeat would.
 *
 * Identical except that it leaves `attempt` alone, and that is the whole point: a 3-second poll
 * feeding the retry count would drive the backoff to its ceiling within seconds of an outage and
 * pace the schedule off traffic that has nothing to do with it. The reachability is worth having
 * immediately; the retry count belongs to the schedule that reads it.
 */
export function notedHostOutcome(statuses: HostStatuses, id: string, probe: HostProbe, now: number): HostStatuses {
  return foldProbe(statuses, id, probe, now, false)
}

function foldProbe(statuses: HostStatuses, id: string, probe: HostProbe, now: number, paces: boolean): HostStatuses {
  const previous = hostStatus(statuses, id)
  const next: HostStatus = probe.ok
    ? // A host that answered is up, whoever asked it: the backoff has nothing left to pace.
      { reachability: 'online', message: null, attempt: 0, checkedAt: now }
    : 'unauthorized' in probe
      ? { reachability: 'unpaired', message: null, attempt: previous.attempt, checkedAt: now }
      : {
          reachability: 'offline',
          message: probe.message,
          attempt: paces ? previous.attempt + 1 : previous.attempt,
          checkedAt: now
        }
  return { ...statuses, [id]: next }
}

/** A host with no token has nothing to check: it is in re-pairing until one is pasted. */
export function unpairedHostStatus(statuses: HostStatuses, id: string, now: number): HostStatuses {
  return { ...statuses, [id]: { reachability: 'unpaired', message: null, attempt: 0, checkedAt: now } }
}

/** Statuses for hosts that still exist. A removed host must not keep reporting from the map. */
export function prunedHostStatuses(statuses: HostStatuses, hosts: SavedHost[]): HostStatuses {
  const kept: HostStatuses = {}
  for (const host of hosts) {
    const status = statuses[host.id]
    if (status) kept[host.id] = status
  }
  return kept
}

/** How long until this host is probed again. */
export function hostProbeDelayMs(status: HostStatus): number {
  if (status.reachability === 'online' || status.reachability === 'unknown') return HOST_PROBE_INTERVAL_MS
  if (status.reachability === 'unpaired') return HOST_UNPAIRED_PROBE_MS
  const bounded = Math.min(Math.max(status.attempt - 1, 0), 4)
  return Math.min(HOST_RETRY_BASE_MS * 2 ** bounded, HOST_RETRY_CEILING_MS)
}

/**
 * A host that answered is worth re-checking, but it is a background heartbeat, not a poll.
 * @internal exported for tests
 */
export const HOST_PROBE_INTERVAL_MS = 15_000
/**
 * A revoked token does not fix itself; the next check is only there to catch a re-paired host.
 * @internal exported for tests
 */
export const HOST_UNPAIRED_PROBE_MS = 30_000
/** @internal exported for tests */
export const HOST_RETRY_BASE_MS = 1_000
/** @internal exported for tests */
export const HOST_RETRY_CEILING_MS = 15_000

export function hostStatusLabel(status: HostStatus): string {
  switch (status.reachability) {
    case 'online':
      return 'Online'
    case 'offline':
      return 'Offline'
    case 'unpaired':
      return 'Needs pairing'
    case 'unknown':
      return 'Checking…'
  }
}

/**
 * The phone's saved hosts, as data.
 *
 * One phone, several Toucan hosts - a work PC and a private one - and each is its own everything: a
 * name, an origin, and a pairing token that authorizes nothing anywhere else. So a host is the unit
 * this whole client is parameterized by, and the decisions about the list live here rather than in
 * the screens that render it: what a typed origin means, when two entries are the same host, what
 * happens to the selection when the selected host is removed, and what a revoked token does to the
 * *other* hosts (nothing).
 *
 * Two rules are load-bearing. **A host is identified by its origin**, so pairing a host that is
 * already saved re-pairs it rather than adding a second entry pointing at the same PC - which is
 * also what makes recovering from a revoked token a matter of pasting the new one. And **a token is
 * per host**: an empty one is not an error state to clear globally but this host's re-pair state,
 * which is why `revokedHostToken` is a list operation and never a reason to forget anything else.
 */

import { isRecord } from '../../src/shared/record'

export interface SavedHost {
  /** Stable across renames and re-pairings, because screens and retained drafts are keyed on it. */
  id: string
  name: string
  /** Normalized `scheme://host[:port]`, never with a path - see `normalizeHostOrigin`. */
  origin: string
  /** Empty means paired-but-revoked: this host needs the token pasting again, and nothing else does. */
  token: string
}

/** What a request needs to reach a host. `SavedHost` satisfies it; so does an unsaved pairing form. */
export interface HostEndpoint {
  origin: string
  token: string
}

export interface HostDirectory {
  hosts: SavedHost[]
  /** Null only when there are no hosts; every mutation keeps a selection if one is possible. */
  selectedId: string | null
}

export const EMPTY_HOST_DIRECTORY: HostDirectory = { hosts: [], selectedId: null }

/** A host being added or re-paired. The name is optional: an origin already names the machine. */
export interface HostDraft {
  name: string
  origin: string
  token: string
}

export function selectedHost(directory: HostDirectory): SavedHost | null {
  return directory.hosts.find((host) => host.id === directory.selectedId) ?? null
}

/** The one reading of "this host cannot be used until the user pastes a token again". */
export function hostNeedsPairing(host: SavedHost): boolean {
  return host.token.length === 0
}

/**
 * What a typed host address means, or null when it means nothing usable.
 *
 * A phone keyboard is a hostile place to type a URL, so the scheme may be left off (assumed plain
 * HTTP, which is what a tailnet host without `tailscale serve` speaks) and anything past the
 * authority is discarded rather than refused: a pasted `http://work-pc:1789/chats/abc` is the same
 * host as `work-pc:1789`, and treating them as different would save two entries for one PC.
 */
export function normalizeHostOrigin(input: string): string | null {
  const trimmed = input.trim()
  if (trimmed.length === 0) return null
  // A bare `work-pc:1789` parses as a URL with the scheme `work-pc:`, so the scheme is decided by
  // shape here rather than left to the parser to guess wrongly.
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`
  try {
    const url = new URL(candidate)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    if (url.hostname.length === 0) return null
    return `${url.protocol}//${url.host}`
  } catch {
    return null
  }
}

export function hostOriginProblem(input: string): string | null {
  if (input.trim().length === 0) return 'Enter the address Toucan is listening on.'
  return normalizeHostOrigin(input) === null ? 'That is not an address this app can reach.' : null
}

/** Why this host cannot be saved yet, or null. The same words the form and the button both use. */
export function hostDraftProblem(draft: HostDraft): string | null {
  const origin = hostOriginProblem(draft.origin)
  if (origin) return origin
  if (draft.token.trim().length === 0) return 'Paste the pairing token from that desktop.'
  return null
}

/** The label an unnamed host gets: the machine it points at, which is what the user typed anyway. */
export function hostLabelFromOrigin(origin: string): string {
  try {
    return new URL(origin).hostname || origin
  } catch {
    return origin
  }
}

/**
 * Saves a host and selects it.
 *
 * Same origin means same host, so this is also the re-pair path: the entry keeps its id - and with
 * it the drafts and screens keyed on that id - while taking the new token, and a newly typed name
 * replaces the old one only if one was actually typed.
 */
export function addHost(directory: HostDirectory, draft: HostDraft, id: string): HostDirectory {
  const origin = normalizeHostOrigin(draft.origin)
  if (origin === null) return directory
  const token = draft.token.trim()
  const typedName = draft.name.trim()
  const existing = directory.hosts.find((host) => host.origin === origin)
  if (existing) {
    return {
      hosts: directory.hosts.map((host) =>
        host.id === existing.id ? { ...host, token, ...(typedName ? { name: typedName } : {}) } : host
      ),
      selectedId: existing.id
    }
  }
  const host: SavedHost = { id, name: typedName || hostLabelFromOrigin(origin), origin, token }
  return { hosts: [...directory.hosts, host], selectedId: host.id }
}

export function renameHost(directory: HostDirectory, id: string, name: string): HostDirectory {
  const trimmed = name.trim()
  if (trimmed.length === 0) return directory
  return {
    ...directory,
    hosts: directory.hosts.map((host) => (host.id === id ? { ...host, name: trimmed } : host))
  }
}

/**
 * Forgets a host. The selection moves to whatever is left rather than becoming null: dropping to no
 * selection would send a phone with two other paired hosts back to the pairing screen.
 */
export function removeHost(directory: HostDirectory, id: string): HostDirectory {
  const hosts = directory.hosts.filter((host) => host.id !== id)
  if (hosts.length === directory.hosts.length) return directory
  if (directory.selectedId !== id) return { ...directory, hosts }
  return { hosts, selectedId: hosts[0]?.id ?? null }
}

export function selectHost(directory: HostDirectory, id: string): HostDirectory {
  return directory.hosts.some((host) => host.id === id) ? { ...directory, selectedId: id } : directory
}

/**
 * A host answered `401`: its token is no longer accepted. Only that host is affected - the whole
 * point of a per-host token is that a revoked one cannot cost the reader access to the other PC -
 * and the selection is kept, because the re-pair screen is for this host.
 */
export function revokedHostToken(directory: HostDirectory, id: string): HostDirectory {
  // Idempotent by identity: the screen polling a host and the schedule probing it can both see the
  // same `401`, and a host already in re-pairing must not be re-saved (and re-rendered) for it.
  if (!directory.hosts.some((host) => host.id === id && host.token.length > 0)) return directory
  return {
    ...directory,
    hosts: directory.hosts.map((host) => (host.id === id ? { ...host, token: '' } : host))
  }
}

export function hostApiUrl(origin: string, path: string): string {
  return `${origin}${path}`
}

/** The chat socket's URL for a host. `ws` follows the host's own scheme, never the page's. */
export function hostSocketUrl(origin: string, path: string): string {
  return `${origin.replace(/^http/, 'ws')}${path}`
}

/**
 * Whether the page can even open a connection to this host. A browser refuses plain HTTP and `ws`
 * from an HTTPS page, and it refuses them *silently* enough that the failure reads as an offline
 * host, so it is worth saying out loud where the reader can act on it - by reaching that host over
 * `tailscale serve` too, or by bookmarking it directly.
 */
export function hostBlockedByPageScheme(origin: string, pageProtocol: string): string | null {
  if (pageProtocol !== 'https:') return null
  return origin.startsWith('http://')
    ? 'This page is served over HTTPS, so the browser will not connect to a plain-HTTP host. Reach it over HTTPS (tailscale serve) or open that host directly.'
    : null
}

/**
 * Reads a stored directory back, keeping whatever survives.
 *
 * Deliberately forgiving rather than validating: this is the phone's own `localStorage`, so a
 * malformed entry means a version skew or a half-finished write, and refusing the whole list would
 * cost the reader every host they had paired. An entry missing an id, name or origin is not a host,
 * so it is dropped; a missing token is a host that needs re-pairing, which is a state this client
 * already knows how to present.
 */
export function parseHostDirectory(raw: unknown): HostDirectory {
  if (!isRecord(raw) || !Array.isArray(raw.hosts)) return EMPTY_HOST_DIRECTORY
  const hosts: SavedHost[] = []
  for (const entry of raw.hosts) {
    if (!isRecord(entry)) continue
    const { id, name, origin, token } = entry
    if (typeof id !== 'string' || id.length === 0) continue
    if (typeof origin !== 'string') continue
    const normalized = normalizeHostOrigin(origin)
    if (normalized === null) continue
    // One entry per origin, first one wins: a duplicate could only come from a write that raced
    // itself, and two entries for one PC would each hold half the state.
    if (hosts.some((host) => host.origin === normalized)) continue
    hosts.push({
      id,
      name: typeof name === 'string' && name.trim().length > 0 ? name : hostLabelFromOrigin(normalized),
      origin: normalized,
      token: typeof token === 'string' ? token : ''
    })
  }
  const selectedId = typeof raw.selectedId === 'string' ? raw.selectedId : null
  return {
    hosts,
    // A selection naming a host that did not survive is worse than none: it would render as an
    // empty chat list rather than as the pairing screen it actually is.
    selectedId: hosts.some((host) => host.id === selectedId) ? selectedId : (hosts[0]?.id ?? null)
  }
}

/**
 * The upgrade path from the single-host slice, where the only thing stored was a token and the host
 * was implicitly whichever origin served the page. That pairing is still valid, so it becomes the
 * first saved host rather than something the user has to redo.
 */
export function migratedHostDirectory(token: string, origin: string, id: string): HostDirectory {
  return addHost(EMPTY_HOST_DIRECTORY, { name: '', origin, token }, id)
}

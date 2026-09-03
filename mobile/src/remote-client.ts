import type { RemoteWorkspaceSnapshot } from '../../src/shared/remote-access'

/**
 * The phone's side of pairing. The host is implicit - it is whatever origin served this page - so
 * the only thing a device has to hold is the token, and it is sent as a bearer header on every
 * request, never in a URL where it would land in logs and history.
 *
 * `localStorage` is the right home for it: it is per device and per origin, which is exactly the
 * scope of a pairing, and it survives the reloads a phone browser does on its own.
 *
 * API paths are absolute. The host serves this client's shell at any path so a reload lands
 * somewhere usable, so a relative `api/workspace` would resolve against whatever path the browser
 * happens to be on and quietly ask the wrong place.
 */
const TOKEN_KEY = 'toucan.pairing-token'

export function storedToken(): string | null {
  try {
    return window.localStorage.getItem(TOKEN_KEY)
  } catch {
    // Private browsing and blocked site data both throw here. Pairing still works for the
    // session; it just will not be remembered.
    return null
  }
}

export function rememberToken(token: string): void {
  try {
    window.localStorage.setItem(TOKEN_KEY, token)
  } catch {
    /* Not remembering a token is a worse session, not a failed pairing. */
  }
}

export function forgetToken(): void {
  try {
    window.localStorage.removeItem(TOKEN_KEY)
  } catch {
    /* Nothing to do: the in-memory token is cleared by the caller either way. */
  }
}

/** Why a request failed, in the two terms the UI actually reacts to. */
export type RemoteFailure = { kind: 'unauthorized' } | { kind: 'unreachable'; message: string }

export type RemoteResult<T> = { ok: true; value: T } | ({ ok: false } & RemoteFailure)

async function request(path: string, token: string, signal?: AbortSignal): Promise<RemoteResult<Response>> {
  try {
    const response = await fetch(path, {
      headers: { authorization: `Bearer ${token}` },
      cache: 'no-store',
      signal
    })
    if (response.status === 401) return { ok: false, kind: 'unauthorized' }
    if (!response.ok) return { ok: false, kind: 'unreachable', message: `Host replied ${response.status}` }
    return { ok: true, value: response }
  } catch (error) {
    return { ok: false, kind: 'unreachable', message: error instanceof Error ? error.message : 'Host unreachable' }
  }
}

/**
 * Checks a token the moment it is entered. Without this the first wrong character would only show
 * up as an empty list, which reads as "nothing is running" rather than "you are not paired".
 */
export async function verifyToken(token: string): Promise<RemoteResult<true>> {
  const result = await request('/api/pairing', token)
  return result.ok ? { ok: true, value: true } : result
}

export async function fetchWorkspace(
  token: string,
  signal?: AbortSignal
): Promise<RemoteResult<RemoteWorkspaceSnapshot>> {
  const result = await request('/api/workspace', token, signal)
  if (!result.ok) return result
  try {
    return { ok: true, value: (await result.value.json()) as RemoteWorkspaceSnapshot }
  } catch (error) {
    return { ok: false, kind: 'unreachable', message: error instanceof Error ? error.message : 'Unreadable reply' }
  }
}

/**
 * How often the list refreshes. Live push arrives with the chat view; until then this is the
 * whole liveness story, so it is fast enough to watch a turn start and finish without being a
 * meaningful drain on either device.
 */
export const WORKSPACE_POLL_MS = 3_000

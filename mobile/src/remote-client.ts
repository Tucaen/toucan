import type { RemoteWorkspaceSnapshot } from '../../src/shared/remote-access'
import type { RemoteChatSpawnRequest } from '../../src/shared/remote-spawn'

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

/**
 * An unsent message, retained on this device only. Not drafts *sync* - the desktop never sees
 * this and never will - but the phone's own retention, which is what keeps the acceptance
 * criterion honest: a token revoked mid-compose unmounts the whole chat screen on its way back to
 * pairing, and the reader must find their text again afterwards rather than retype it. Also
 * covers what phone browsers do unasked: evicting a background tab.
 */
const DRAFT_KEY_PREFIX = 'toucan.draft.'

export function storedDraft(chatId: string): string {
  try {
    return window.localStorage.getItem(DRAFT_KEY_PREFIX + chatId) ?? ''
  } catch {
    return ''
  }
}

export function rememberDraft(chatId: string, draft: string): void {
  try {
    if (draft.length === 0) window.localStorage.removeItem(DRAFT_KEY_PREFIX + chatId)
    else window.localStorage.setItem(DRAFT_KEY_PREFIX + chatId, draft)
  } catch {
    /* Blocked site data costs retention, not the ability to send. */
  }
}

/** Why a request failed, in the two terms the UI actually reacts to. */
export type RemoteFailure = { kind: 'unauthorized' } | { kind: 'unreachable'; message: string }

export type RemoteResult<T> = { ok: true; value: T } | ({ ok: false } & RemoteFailure)

/**
 * One request, with the pairing header and the two failures every caller reacts to. A non-`ok`
 * status is *not* one of them: only the caller knows whether the body carries a reason worth
 * reading, so the response is handed over whatever it says and `request` decides for the callers
 * that have nothing to read.
 */
async function send(path: string, token: string, init: RequestInit = {}): Promise<RemoteResult<Response>> {
  try {
    const response = await fetch(path, {
      ...init,
      headers: { ...init.headers, authorization: `Bearer ${token}` },
      cache: 'no-store'
    })
    return response.status === 401 ? { ok: false, kind: 'unauthorized' } : { ok: true, value: response }
  } catch (error) {
    return { ok: false, kind: 'unreachable', message: error instanceof Error ? error.message : 'Host unreachable' }
  }
}

async function request(path: string, token: string, signal?: AbortSignal): Promise<RemoteResult<Response>> {
  const result = await send(path, token, signal ? { signal } : {})
  if (!result.ok) return result
  if (!result.value.ok) return { ok: false, kind: 'unreachable', message: `Host replied ${result.value.status}` }
  return result
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
 * Asks the desktop to start a chat, and answers with the id of one that actually exists.
 *
 * This is the only request the phone makes that *changes* the desktop, and it is deliberately the
 * slow one: the host holds it open until the canvas has added the node and the session behind it
 * has come up. That is what makes the reply safe to navigate to. A refusal carries the host's own
 * wording - no window open, a session that died, a project that has since been closed - because
 * every one of those is something the reader can act on, and none of them is "try again".
 */
export async function createChat(token: string, spawn: RemoteChatSpawnRequest): Promise<RemoteResult<string>> {
  const sent = await send('/api/chats', token, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(spawn)
  })
  if (!sent.ok) return sent
  const response = sent.value

  const payload = await readJsonBody(response)
  if (!response.ok) {
    const reported = typeof payload?.error === 'string' ? payload.error : null
    return { ok: false, kind: 'unreachable', message: reported ?? `Host replied ${response.status}` }
  }
  if (typeof payload?.chatId !== 'string' || payload.chatId.length === 0) {
    return { ok: false, kind: 'unreachable', message: 'The host did not say which chat it started.' }
  }
  return { ok: true, value: payload.chatId }
}

/** A body that is not JSON is not a reason to lose the status; the caller falls back to it. */
async function readJsonBody(response: Response): Promise<{ chatId?: unknown; error?: unknown } | null> {
  try {
    return (await response.json()) as { chatId?: unknown; error?: unknown }
  } catch {
    return null
  }
}

/**
 * How often the list refreshes. Live push arrives with the chat view; until then this is the
 * whole liveness story, so it is fast enough to watch a turn start and finish without being a
 * meaningful drain on either device.
 */
export const WORKSPACE_POLL_MS = 3_000

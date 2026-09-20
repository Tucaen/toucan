import { parseAgentModelCatalogue, type AgentModelCatalogue } from '../../src/shared/agent-model-catalogue'
import type { RemoteWorkspaceSnapshot } from '../../src/shared/remote-access'
import type { ProviderUsageReport } from '../../src/shared/agent'
import type { RemoteChatSpawnRequest } from '../../src/shared/remote-spawn'
import { parseProviderUsageReport } from '../../src/shared/remote-usage'
import { parseRemoteTranscriptionReply, REMOTE_VOICE_CONTENT_TYPE } from '../../src/shared/remote-voice'
import {
  EMPTY_HOST_DIRECTORY,
  hostApiUrl,
  migratedHostDirectory,
  newHostId,
  parseHostDirectory,
  type HostDirectory,
  type HostEndpoint
} from './hosts'

/**
 * The phone's side of talking to a host. Every request is addressed to one saved host and carries
 * that host's token as a bearer header, never in a URL where it would land in logs and history.
 *
 * The host is *explicit*, which is the whole difference from the single-host slice: this client is
 * served by one host but may hold connections to another, so a relative `/api/workspace` would
 * always ask whoever served the page. Paths are still absolute against the host's origin, because
 * the host serves this client's shell at any path so a reload lands somewhere usable - a relative
 * path would resolve against whatever route the browser happens to be on.
 *
 * `localStorage` is the right home for what has to persist: it is per device and per origin, which
 * is exactly the scope of a pairing, and it survives the reloads a phone browser does on its own.
 * Every read and write is wrapped, because private browsing and blocked site data both throw here -
 * and losing the saved hosts must cost this session's convenience, never the ability to pair.
 */
const HOSTS_KEY = 'toucan.hosts'

/** The single-host slice's key. Read once, migrated into a host, then removed. */
const LEGACY_TOKEN_KEY = 'toucan.pairing-token'

export function storedHostDirectory(): HostDirectory {
  try {
    const raw = window.localStorage.getItem(HOSTS_KEY)
    if (raw !== null) return parseHostDirectory(JSON.parse(raw))
    return migratedLegacyPairing()
  } catch {
    return EMPTY_HOST_DIRECTORY
  }
}

export function rememberHostDirectory(directory: HostDirectory): void {
  try {
    window.localStorage.setItem(HOSTS_KEY, JSON.stringify(directory))
  } catch {
    /* Not remembering the host list is a worse session, not a failed pairing. */
  }
}

/**
 * A device paired before there was a host list still holds a valid token for the host that served
 * it, so that pairing becomes the first saved entry rather than something the user redoes.
 */
function migratedLegacyPairing(): HostDirectory {
  const token = window.localStorage.getItem(LEGACY_TOKEN_KEY)
  if (token === null || token.length === 0) return EMPTY_HOST_DIRECTORY
  const migrated = migratedHostDirectory(token, window.location.origin, newHostId())
  rememberHostDirectory(migrated)
  try {
    window.localStorage.removeItem(LEGACY_TOKEN_KEY)
  } catch {
    /* A key left behind is harmless: the migration only runs when no host list exists. */
  }
  return migrated
}

/**
 * An unsent message, retained on this device only. Not drafts *sync* - the desktop never sees this
 * and never will - but the phone's own retention, which is what keeps the acceptance criterion
 * honest: a token revoked mid-compose unmounts the whole chat screen on its way back to pairing,
 * and the reader must find their text again afterwards rather than retype it. Also covers what
 * phone browsers do unasked: evicting a background tab.
 *
 * Keyed by host as well as chat, because a chat id only identifies a node on the host that minted
 * it and two hosts can hand out the same one.
 */
const DRAFT_KEY_PREFIX = 'toucan.draft.'

function draftKey(hostId: string, chatId: string): string {
  return `${DRAFT_KEY_PREFIX}${hostId}.${chatId}`
}

export function storedDraft(hostId: string, chatId: string): string {
  try {
    return window.localStorage.getItem(draftKey(hostId, chatId)) ?? ''
  } catch {
    return ''
  }
}

export function rememberDraft(hostId: string, chatId: string, draft: string): void {
  try {
    if (draft.length === 0) window.localStorage.removeItem(draftKey(hostId, chatId))
    else window.localStorage.setItem(draftKey(hostId, chatId), draft)
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
 *
 * A cross-host request that the browser blocks - CORS refused, a plain-HTTP host from an HTTPS
 * page - throws here exactly like an unreachable one, and is reported as unreachable. That is the
 * honest reading: from the phone's side the host cannot be talked to, and the switcher says which
 * host it is.
 */
async function send(path: string, host: HostEndpoint, init: RequestInit = {}): Promise<RemoteResult<Response>> {
  try {
    const response = await fetch(hostApiUrl(host.origin, path), {
      ...init,
      headers: { ...init.headers, authorization: `Bearer ${host.token}` },
      cache: 'no-store'
    })
    return response.status === 401 ? { ok: false, kind: 'unauthorized' } : { ok: true, value: response }
  } catch (error) {
    return { ok: false, kind: 'unreachable', message: error instanceof Error ? error.message : 'Host unreachable' }
  }
}

async function request(path: string, host: HostEndpoint, signal?: AbortSignal): Promise<RemoteResult<Response>> {
  const result = await send(path, host, signal ? { signal } : {})
  if (!result.ok) return result
  if (!result.value.ok) return { ok: false, kind: 'unreachable', message: `Host replied ${result.value.status}` }
  return result
}

/**
 * Checks a token against a host. Two jobs, one request: it is the pairing screen's answer the
 * moment a token is entered - without it the first wrong character would only show up as an empty
 * list, which reads as "nothing is running" rather than "you are not paired" - and it is the
 * cheapest thing to ask a saved host to find out whether it is still there.
 */
export async function verifyHost(host: HostEndpoint, signal?: AbortSignal): Promise<RemoteResult<true>> {
  const result = await request('/api/pairing', host, signal)
  return result.ok ? { ok: true, value: true } : result
}

export async function fetchWorkspace(
  host: HostEndpoint,
  signal?: AbortSignal
): Promise<RemoteResult<RemoteWorkspaceSnapshot>> {
  const result = await request('/api/workspace', host, signal)
  if (!result.ok) return result
  try {
    return { ok: true, value: (await result.value.json()) as RemoteWorkspaceSnapshot }
  } catch (error) {
    return { ok: false, kind: 'unreachable', message: error instanceof Error ? error.message : 'Unreadable reply' }
  }
}

/**
 * What each provider was last seen to offer on this host, for the new-chat form's model picker.
 *
 * An empty catalogue is an ordinary answer, not a failure: a desktop that has not run an agent of
 * that kind since it was installed genuinely has nothing to report, because a model list comes from
 * a live ACP session. The form stays usable with no model named - omitting one means "whatever the
 * desktop would have picked" - so a caller renders what it got and never blocks on this.
 */
export async function fetchModels(
  host: HostEndpoint,
  signal?: AbortSignal
): Promise<RemoteResult<AgentModelCatalogue>> {
  const result = await request('/api/models', host, signal)
  if (!result.ok) return result
  try {
    // Parsed through the shared predicate rather than cast: this list populates a control whose
    // choice is sent back to start a process, so a damaged entry is dropped rather than offered.
    return { ok: true, value: parseAgentModelCatalogue(await result.value.json()) ?? {} }
  } catch (error) {
    return { ok: false, kind: 'unreachable', message: error instanceof Error ? error.message : 'Unreadable reply' }
  }
}

/**
 * What the account behind each provider has left on this host (issue #195).
 *
 * Read-only by construction: there is no way to ask for a *forced* read, because a forced read
 * boots a provider CLI process on someone's desktop and this is a surface a paired client could
 * hammer. The phone takes the host's cached reading on a poll no faster than the desktop's own, so
 * however often it asks, at most one provider read per host-side TTL follows. A reading older than
 * it looks says so through `stale` rather than being refreshed.
 *
 * Parsed through the shared predicate rather than cast, like the model catalogue: these figures are
 * what a reader decides whether to keep working on, so a damaged field is dropped rather than
 * rendered as a bar of width `NaN%`. An empty report is an ordinary answer - a desktop that has not
 * read its providers yet genuinely has nothing to say.
 */
export async function fetchProviderUsage(
  host: HostEndpoint,
  signal?: AbortSignal
): Promise<RemoteResult<ProviderUsageReport>> {
  const result = await request('/api/usage', host, signal)
  if (!result.ok) return result
  try {
    return { ok: true, value: parseProviderUsageReport(await result.value.json()) ?? {} }
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
export async function createChat(host: HostEndpoint, spawn: RemoteChatSpawnRequest): Promise<RemoteResult<string>> {
  const sent = await send('/api/chats', host, {
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

/**
 * Hands the host a recording and gets its transcript back. For phones whose browser has no speech
 * recognizer of its own: the desktop's model does the work, so the reply takes as long as the
 * desktop takes, and a refusal - no model prepared, a recording too long - is the desktop's own
 * wording, which is what the reader needs to fix it.
 */
export async function transcribeRecording(
  host: HostEndpoint,
  pcm: Uint8Array<ArrayBuffer>
): Promise<RemoteResult<string>> {
  const sent = await send('/api/transcribe', host, {
    method: 'POST',
    headers: { 'content-type': REMOTE_VOICE_CONTENT_TYPE },
    body: pcm
  })
  if (!sent.ok) return sent
  const response = sent.value
  const reply = parseRemoteTranscriptionReply(await readJsonBody(response))
  if (!reply) return { ok: false, kind: 'unreachable', message: `Host replied ${response.status}` }
  return reply.ok ? { ok: true, value: reply.text } : { ok: false, kind: 'unreachable', message: reply.message }
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

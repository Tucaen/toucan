import { parseAgentModelCatalogue, type AgentModelCatalogue } from '../../src/shared/agent-model-catalogue'
import type { RemoteWorkspaceSnapshot } from '../../src/shared/remote-access'
import type { ProviderUsageReport } from '../../src/shared/agent'
import type { AppUpdateSnapshot } from '../../src/shared/app-update'
import {
  parseAppUpdateSnapshot,
  parseRemoteRestartReply,
  type RemoteRestartReply
} from '../../src/shared/remote-app-update'
import type { RemoteChatSpawnRequest } from '../../src/shared/remote-spawn'
import { remoteFileRequestPath } from '../../src/shared/remote-file'
import { parseProviderUsageReport } from '../../src/shared/remote-usage'
import { parseRemoteTranscriptionReply, REMOTE_VOICE_CONTENT_TYPE } from '../../src/shared/remote-voice'
import {
  EMPTY_HOST_DIRECTORY,
  hostApiUrl,
  migratedHostDirectory,
  parseHostDirectory,
  type HostDirectory,
  type HostEndpoint
} from './hosts'
import { newLocalId } from './local-id'

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
  const migrated = migratedHostDirectory(token, window.location.origin, newLocalId())
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

/**
 * Whether the phone shows a chat in Focus mode, retained on this device. Focus is the default here
 * (a phone screen has no room for tool chatter), so only an explicit choice is stored and anything
 * missing, unreadable or unrecognised reads as on. The desktop's own default is unaffected: this
 * key is the phone's alone.
 */
const FOCUS_KEY = 'toucan.focus'

export function storedFocusMode(): boolean {
  try {
    return window.localStorage.getItem(FOCUS_KEY) !== 'off'
  } catch {
    return true
  }
}

export function rememberFocusMode(enabled: boolean): void {
  try {
    window.localStorage.setItem(FOCUS_KEY, enabled ? 'on' : 'off')
  } catch {
    /* Blocked site data costs retention, not the toggle. */
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
    return { ok: false, kind: 'unreachable', message: hostRefusal(payload, response.status) }
  }
  if (typeof payload?.chatId !== 'string' || payload.chatId.length === 0) {
    return { ok: false, kind: 'unreachable', message: 'The host did not say which chat it started.' }
  }
  return { ok: true, value: payload.chatId }
}

/**
 * The orchestrator's Continue (+20) at its spawn budget: the host runs the same controller
 * operation the desktop button does. A stale press (already continued) is accepted as a no-op, so
 * a refusal here is only ever a reason the reader can read - not an orchestrator, not open.
 */
export async function continueSpawns(host: HostEndpoint, chatId: string): Promise<RemoteResult<true>> {
  const sent = await send(`/api/chats/${encodeURIComponent(chatId)}/continue-spawns`, host, { method: 'POST' })
  if (!sent.ok) return sent
  if (sent.value.ok) return { ok: true, value: true }
  const payload = await readJsonBody(sent.value)
  return { ok: false, kind: 'unreachable', message: hostRefusal(payload, sent.value.status) }
}

/**
 * The desktop's update state, exactly as its header chip reads it (#5). A host too old to have the
 * route answers 404, which arrives here as an ordinary failure: the phone then shows no update card.
 */
export async function fetchAppUpdate(
  host: HostEndpoint,
  signal?: AbortSignal
): Promise<RemoteResult<AppUpdateSnapshot>> {
  const result = await request('/api/app-update', host, signal)
  if (!result.ok) return result
  return parsedSnapshot(result.value)
}

/** Runs the desktop's own check; a found update downloads on its own. Answers once the check settles. */
export async function checkAppUpdate(host: HostEndpoint): Promise<RemoteResult<AppUpdateSnapshot>> {
  const sent = await send('/api/app-update/check', host, {
    method: 'POST',
    signal: AbortSignal.timeout(CHECK_TIMEOUT_MS)
  })
  if (!sent.ok) return sent
  if (!sent.value.ok)
    return { ok: false, kind: 'unreachable', message: hostRefusal(await readJsonBody(sent.value), sent.value.status) }
  return parsedSnapshot(sent.value)
}

async function parsedSnapshot(response: Response): Promise<RemoteResult<AppUpdateSnapshot>> {
  const snapshot = parseAppUpdateSnapshot(await readJsonBody(response))
  return snapshot ? { ok: true, value: snapshot } : { ok: false, kind: 'unreachable', message: 'Unreadable reply' }
}

/** A check waits on the release feed; past this, the reader is better told than kept waiting. */
const CHECK_TIMEOUT_MS = 60_000
/** The restart answers at once - before the host goes down - so a slow reply is a lost one. */
const RESTART_TIMEOUT_MS = 15_000

/**
 * Asks the desktop to restart into its downloaded update. Unconfirmed, a host with busy sessions
 * answers with the warning to show instead of restarting; `confirmed` is the reader's yes to it.
 * Every reply the host wrote is a value here, refusals included - only a request that never got an
 * answer is a failure, and the caller decides what that means mid-restart.
 */
export async function restartForUpdate(
  host: HostEndpoint,
  confirmed: boolean
): Promise<RemoteResult<RemoteRestartReply>> {
  const sent = await send('/api/app-update/restart', host, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(confirmed ? { confirmed: true } : {}),
    // A host going down mid-reply can leave the connection half open; giving up turns that into the
    // same "no answer" a dropped connection is, which the caller reads as the restart under way.
    signal: AbortSignal.timeout(RESTART_TIMEOUT_MS)
  })
  if (!sent.ok) return sent
  const payload = await readJsonBody(sent.value)
  const reply = parseRemoteRestartReply(payload)
  if (reply) return { ok: true, value: reply }
  return { ok: true, value: { restarting: false, error: hostRefusal(payload, sent.value.status) } }
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

/**
 * The bytes of one local image a chat linked to, fetched from the host that holds it. Fetched
 * rather than set as an `<img src>`, because the token must travel as a header and an image
 * request cannot carry one. A refusal carries the host's own wording - outside the workspace, gone,
 * too large - since each is something the reader can make sense of.
 */
export async function fetchLocalImage(
  host: HostEndpoint,
  path: string,
  signal?: AbortSignal
): Promise<RemoteResult<Blob>> {
  const sent = await send(remoteFileRequestPath(path), host, signal ? { signal } : {})
  if (!sent.ok) return sent
  const response = sent.value
  if (!response.ok) {
    const payload = await readJsonBody(response)
    return { ok: false, kind: 'unreachable', message: hostRefusal(payload, response.status) }
  }
  try {
    return { ok: true, value: await response.blob() }
  } catch (error) {
    return { ok: false, kind: 'unreachable', message: error instanceof Error ? error.message : 'Unreadable reply' }
  }
}

/** The host's own reason for a refusal when it gave one, else the status it replied with. */
function hostRefusal(payload: { error?: unknown } | null, status: number): string {
  return typeof payload?.error === 'string' ? payload.error : `Host replied ${status}`
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

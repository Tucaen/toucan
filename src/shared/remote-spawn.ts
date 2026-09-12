import type { RemoteChatKind } from './remote-access'
import { promptTextProblem, REMOTE_CHAT_MODEL_ID_LIMIT, REMOTE_CHAT_PROMPT_LIMIT } from './remote-chat'
import type { TerminalNodeStatus } from './terminal'

/**
 * The contract for starting a *new* chat from a paired device.
 *
 * Everything else a phone does addresses a chat that already exists; this is the one operation
 * that has to bring one into being, and node identity is not the host's to mint. The canvas owns
 * ids, geometry, working-directory resolution and launch mode, so a spawn is a request the desktop
 * renderer performs through its own add-node path - which is what makes a remotely spawned node
 * indistinguishable from one created by a right-click on the canvas.
 *
 * Two consequences shape this module. The result is a *verdict*, never an optimistic id: a phone
 * that is told a chat exists will navigate to it, so an id is only ever reported once the session
 * behind it is actually up. And the settlement rule - when a spawn has succeeded, failed, or is
 * still coming up - is `spawnSettlement` here rather than a status comparison written twice, so
 * the renderer that waits and any test that asserts on it read the same rule.
 */
export interface RemoteChatSpawnRequest {
  /** A project the published projection lists; the host refuses anything else. */
  projectId: string
  kind: RemoteChatKind
  /**
   * The first prompt, sent as the session comes up. Absent means "just open it": an empty string
   * is not a prompt, so the phone omits the field rather than sending one the host would refuse.
   */
  input?: string
  /**
   * The model this chat should run on. Absent means "whatever the desktop's own add-node path
   * would have picked", which is always valid and is what a client with no catalogue to offer
   * sends - so this stays optional rather than becoming a choice a phone is forced to make.
   *
   * It is a *request*: the id comes from `GET /api/models`, which is what providers were last seen
   * to advertise rather than a live list, so the host checks it against that same catalogue and
   * the session manager has the final say when the session actually opens.
   */
  modelId?: string
}

export type RemoteChatSpawnResult = { ok: true; chatId: string } | { ok: false; message: string }

/**
 * How large a spawn body may be. The initial input is an ordinary prompt, so it is bounded by the
 * same limit a prompt frame is; the headroom covers the JSON envelope and multi-byte characters.
 */
export const REMOTE_SPAWN_BODY_LIMIT = REMOTE_CHAT_PROMPT_LIMIT * 4 + 1024

/**
 * Whether this request may be sent at all, and why not. Both ends run this one function - the
 * phone greys out its Start button in the words the host would have refused it with - for the same
 * reason `promptTextProblem` is shared: a client and a host that disagree about what is valid
 * produce a failure nobody can act on.
 */
export function remoteChatSpawnProblem(request: RemoteChatSpawnRequest): string | null {
  if (request.projectId.trim().length === 0) return 'Pick a project first.'
  if (request.kind !== 'claude' && request.kind !== 'codex') return 'Pick an agent first.'
  // Shape only. Whether this provider actually offers the model is the host's check against its
  // own catalogue - a client cannot be the authority on a list it was handed.
  if (request.modelId !== undefined && request.modelId.length > REMOTE_CHAT_MODEL_ID_LIMIT) {
    return 'That model name is too long to send.'
  }
  if (request.input !== undefined) return promptTextProblem(request.input)
  return null
}

/**
 * Parses one spawn body the host received. Strict, like every inbound frame: this request starts a
 * process in a working directory, so an unrecognized shape is refused rather than guessed at.
 */
export function parseRemoteChatSpawnRequest(raw: string): RemoteChatSpawnRequest | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const body = parsed as { projectId?: unknown; kind?: unknown; input?: unknown; modelId?: unknown }
  if (typeof body.projectId !== 'string') return null
  if (body.kind !== 'claude' && body.kind !== 'codex') return null
  // A present-but-not-a-string input is a malformed body, not an absent prompt: reading it as one
  // would silently open a chat that was meant to start working.
  if (body.input !== undefined && typeof body.input !== 'string') return null
  // Same rule for the model: a malformed one is refused rather than read as "no preference", or a
  // version skew would quietly start the chat on something other than what was picked.
  if (body.modelId !== undefined && (typeof body.modelId !== 'string' || body.modelId.length === 0)) return null
  return {
    projectId: body.projectId,
    kind: body.kind,
    ...(typeof body.input === 'string' ? { input: body.input } : {}),
    ...(typeof body.modelId === 'string' ? { modelId: body.modelId } : {})
  }
}

/** Whether a spawned node's reported status settles its spawn, and how. */
export type SpawnSettlement = 'pending' | 'started' | 'failed'

/**
 * Reads a spawn's outcome off the status the new node reports.
 *
 * `starting` is the only status that means "still coming up". Everything a live session reports -
 * idle, working, a result, a request for attention, even a stalled turn - means the session exists,
 * which is all a spawn ever claimed. `exited` and `dormant` are the failures: one is a session that
 * came up and died, the other a node that never launched one, and reporting either as a chat the
 * phone can open would be the phantom this whole round-trip exists to prevent.
 */
export function spawnSettlement(status: TerminalNodeStatus): SpawnSettlement {
  if (status === 'starting') return 'pending'
  if (status === 'exited' || status === 'dormant') return 'failed'
  return 'started'
}

/** What the phone is told when a session came up and immediately died. */
export const SPAWN_FAILED_MESSAGE = 'The agent session could not be started on the desktop.'

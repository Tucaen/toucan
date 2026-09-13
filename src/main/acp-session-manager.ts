import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { shell, type WebContents } from 'electron'
import {
  client,
  methods,
  ndJsonStream,
  type AuthMethod,
  type AvailableCommand,
  type ClientConnection,
  type ClientContext,
  type ContentBlock,
  type CreateElicitationRequest,
  type CreateElicitationResponse,
  type RequestPermissionResponse,
  type SessionConfigOption
} from '@agentclientprotocol/sdk'
import type {
  AgentAuthMethod,
  AgentCommand,
  AgentCreateRequest,
  AgentCreateResult,
  AgentDecisionQuestion,
  AgentDecisionResponseContent,
  AgentEffortState,
  AgentEvent,
  AgentModeState,
  AgentMessagePresentation,
  AgentModelState,
  AgentPermissionOption,
  AgentPromptBlock,
  AgentPromptTextBlock,
  AgentPromptContent,
  AgentPromptResult
} from '../shared/agent'
import { MODEL_CHANGE_WHILE_BUSY, type AgentModel } from '../shared/agent'
import type { AgentProvider } from '../shared/agent-provider'
import {
  activityFromUpdate,
  imageContentFrom,
  isFileWritingToolKind,
  type AgentFileWrite
} from '../shared/agent-activity'
import { agentPermissionTitle } from '../shared/agent-permission'
import { effortSelectorFromConfigOptions } from '../shared/agent-effort'
import { modelSelectorFromConfigOptions } from '../shared/agent-models'
import {
  appliedClaudeDelegation,
  appliedCodexDelegation,
  claudeDelegationSessionMeta,
  withCodexDelegationEnvironment,
  type AgentRoutineDelegation,
  type ClaudeDelegationSessionMeta,
  type RoutineDelegationRequest
} from '../shared/routine-delegation'
import { createAgentEventBroker, type AgentEventBroker } from './agent-event-broker'
import { buildAgentProcessLaunch, spawnAgentProcess, type AgentProcessLaunch } from './agent-process'
import { readCachedCodexModels } from './codex-model-cache'
import { createPromptWakeGate, type PromptWakeGate } from './prompt-wake-gate'
import type { SessionOutcomeIndexer, SessionOutcomeWatch } from './session-outcome-indexer'
import { AGENT_CHANNELS } from '../shared/ipc-channels'

interface PendingApproval {
  resolve(response: RequestPermissionResponse): void
}

interface PendingElicitation {
  resolve(response: CreateElicitationResponse): void
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function enumOptions(schema: Record<string, unknown>): Array<{ value: string; label: string; description?: string }> {
  const choices = Array.isArray(schema.oneOf)
    ? schema.oneOf
    : Array.isArray(schema.anyOf)
      ? schema.anyOf
      : Array.isArray(schema.enum)
        ? (schema.enum as unknown[]).map((value) => ({ const: value }))
        : []
  return choices.flatMap((choice) => {
    const item = record(choice)
    if (!item) return []
    const value = item.const
    if (typeof value !== 'string') return []
    return [
      {
        value,
        label: typeof item.title === 'string' ? item.title : value,
        ...(typeof item.description === 'string' ? { description: item.description } : {})
      }
    ]
  })
}

export function decisionQuestions(request: CreateElicitationRequest): AgentDecisionQuestion[] {
  if (request.mode !== 'form' || !('requestedSchema' in request)) return []
  const schema = record(request.requestedSchema)
  const properties = record(schema?.properties) ?? {}
  const required = new Set(
    Array.isArray(schema?.required)
      ? (schema.required as unknown[]).filter((id): id is string => typeof id === 'string')
      : []
  )
  const customFor = new Map<string, string>()
  for (const [id, value] of Object.entries(properties)) {
    const property = record(value)
    const meta = record(property?._meta)
    const marker = record(meta?._askUserQuestionCustomAnswer)
    const questionId = marker?.questionId
    if (marker?.isCustomAnswer === true && typeof questionId === 'string') customFor.set(questionId, id)
    else if (id.endsWith('__other')) customFor.set(id.slice(0, -'__other'.length), id)
  }
  return Object.entries(properties).flatMap(([id, value]) => {
    const property = record(value)
    if (!property || [...customFor.values()].includes(id)) return []
    const multiSelect = property.type === 'array'
    const optionSchema = multiSelect ? (record(property.items) ?? {}) : property
    const options = enumOptions(optionSchema)
    const input =
      options.length > 0
        ? 'select'
        : property.type === 'string'
          ? 'text'
          : property.type === 'number' || property.type === 'integer'
            ? 'number'
            : property.type === 'boolean'
              ? 'boolean'
              : null
    if (!input) return []
    return [
      {
        id,
        ...(typeof property.title === 'string' ? { title: property.title } : {}),
        question: typeof property.description === 'string' ? property.description : request.message,
        options,
        input,
        multiSelect,
        ...(required.has(id) ? { required: true } : {}),
        ...(customFor.has(id) ? { customAnswerId: customFor.get(id) } : {})
      }
    ]
  })
}

/** The directory holding agent skills inside either a project or the Toucan application. */
const PROJECT_SKILLS_DIRECTORY = '.agents'

interface SessionSkillsConfiguration {
  additionalDirectories?: string[]
  _meta?: {
    claudeCode: {
      options: {
        plugins?: Array<{ type: 'local'; path: string }>
        agents?: ClaudeDelegationSessionMeta['claudeCode']['options']['agents']
      }
    }
    systemPrompt?: ClaudeDelegationSessionMeta['systemPrompt']
  }
}

/** Resolves unpacked application skills so native provider processes can read packaged builds. */
export function resolveToucanSkillsRoot(appPath: string, pathExists = existsSync): string | undefined {
  const roots = [appPath]
  if (appPath.endsWith('app.asar')) roots.unshift(join(dirname(appPath), 'app.asar.unpacked'))
  return roots.find((root) => pathExists(join(root, PROJECT_SKILLS_DIRECTORY, 'skills')))
}

/**
 * Toucan-owned skills are session-scoped and never installed into global agent configuration.
 * Codex uses an additional root for them; Claude receives each skill directory as a local plugin.
 */
export function sessionSkillsConfiguration(
  provider: AgentCreateRequest['provider'],
  cwd: string,
  toucanRoot?: string,
  pathExists = existsSync
): SessionSkillsConfiguration {
  if (provider === 'codex') {
    return toucanRoot && toucanRoot !== cwd ? { additionalDirectories: [toucanRoot] } : {}
  }
  const plugins = [...new Set([cwd, toucanRoot].filter((root): root is string => Boolean(root)))]
    .map((root) => join(root, PROJECT_SKILLS_DIRECTORY))
    .filter((path) => pathExists(join(path, 'skills')))
    .map((path) => ({ type: 'local' as const, path }))
  return plugins.length > 0 ? { _meta: { claudeCode: { options: { plugins } } } } : {}
}

/**
 * Layers the routine worker into a Claude session's `_meta`, beside the skills plugins. The SDK
 * options object is one bag, so a delegating session's `agents` and the skills' `plugins` travel
 * in the same `claudeCode.options`; the routing instruction is a `claude_code` preset append.
 */
export function withClaudeDelegation(
  configuration: SessionSkillsConfiguration,
  worker: RoutineDelegationRequest
): SessionSkillsConfiguration {
  const meta = claudeDelegationSessionMeta(worker)
  return {
    ...configuration,
    _meta: {
      claudeCode: { options: { ...configuration._meta?.claudeCode.options, ...meta.claudeCode.options } },
      systemPrompt: meta.systemPrompt
    }
  }
}

/** Adds a request's own additional directories to the skills configuration, deduplicated and in order. */
export function withAdditionalDirectories(
  configuration: SessionSkillsConfiguration,
  directories: readonly string[] | undefined
): SessionSkillsConfiguration {
  const merged = [...new Set([...(configuration.additionalDirectories ?? []), ...(directories ?? [])])]
  return merged.length > 0 ? { ...configuration, additionalDirectories: merged } : configuration
}

interface RunningAgent {
  request: AgentCreateRequest
  owner: WebContents
  process: ChildProcessWithoutNullStreams
  connection: ClientConnection
  context: ClientContext
  adapterPath: string
  authProcess?: (args: string[]) => AgentProcessLaunch
  /** Live terminal-auth child, kept separate from the long-running ACP adapter process. */
  authChild?: ChildProcessWithoutNullStreams
  /** Writable prompt input for a terminal-auth flow that may require a browser paste-back code. */
  authInput?: Writable
  authMethods: AgentAuthMethod[]
  environment: NodeJS.ProcessEnv
  /**
   * The routine-delegation policy this agent launched with. The carrier is fixed at launch (the
   * `CODEX_CONFIG` environment for Codex, the session `_meta` for Claude), so a preference changed
   * after launch cannot alter it - every open of this agent reports this record, never the current
   * preference. A Claude record can still turn `unavailable` once the session lists its models.
   */
  routineDelegation?: AgentRoutineDelegation
  cachedModels?: AgentModelState
  /** Whether the agent's `initialize` handshake advertised `promptCapabilities.image`. */
  imageSupport: boolean
  /** Whether the adapter can inject a prompt into the active turn at its own safe boundary. */
  steeringSupport: boolean
  sessionId?: string
  modelConfigId?: string
  effortConfigId?: string
  cachedEfforts?: AgentEffortState
  /**
   * The slash commands and skills this session last advertised. Kept so reopening an existing
   * agent (which skips the handshake that produced the notification) can hand them back rather
   * than leaving the composer's completion empty until the agent happens to publish again.
   */
  cachedCommands?: AgentCommand[]
  /** Events emitted synchronously by `session/load`, held until `agent:create` returns. */
  replayEvents?: AgentEvent[]
  /** Identity cursor for adapters whose replay chunks omit ACP message IDs. */
  replayMessageSequence?: number
  replayMessageKey?: string
  replayMessageId?: string
  pendingApprovals: Map<string, PendingApproval>
  pendingElicitations: Map<string, PendingElicitation>
  /**
   * The files this session's tool calls reported changing, newest last and bounded: the evidence
   * behind "which session wrote this file", which is the only attribution Toucan has for work an
   * agent did on disk. Paths are resolved against the session's `cwd` as they arrive, so a
   * comparison later never has to know where the session was running.
   */
  recentWrites: Array<{ path: string; at: number }>
  /**
   * This session's handle on the outcome index, where one is wired. Held on the running agent so
   * the tool-call seam can report a write without the index having to re-classify the call.
   */
  sessionOutcomes?: SessionOutcomeWatch
  busy: boolean
  stopping: boolean
  /**
   * Set once an `auth_required` event has been sent for this agent and cleared only when a
   * fresh `openSession` succeeds (reauth completes). While true, `runPrompt` short-circuits
   * instead of re-attempting the prompt: without this, a wake-gate queue built up while the
   * agent was `working` drains straight through the same broken credential, re-sending an
   * identical `auth`/`auth_required` event pair (and flashing `status: 'working'` in between)
   * once per queued message — the sign-in affordance the user needs never settles long enough
   * to read or click.
   */
  authRequired: boolean
  /**
   * True from launch until `openSession` settles (and again for each reopen). Adapter
   * stderr is surfaced as `starting` progress only while this holds: stderr and stdout are separate
   * pipes, so a diagnostic logged during `session/load` (claude-agent-acp's `[session/load]` timing
   * line, say) routinely lands *after* the response that made the session ready. Publishing it as
   * `starting` then would pin the renderer's composer disabled forever (GitHub issue #158).
   */
  opening: boolean
  wakeGate?: PromptWakeGate<AgentPromptContent>
}

/**
 * The adapter diagnostics that carry nothing a user could act on, so they are never published as
 * `starting` progress. claude-agent-acp probes `claude auth status --json` while the session opens
 * and logs every failed read to stderr; the probe is advisory - the session's own account info is
 * what the header and the sign-in affordance read - so a probe that times out, fails, or returns
 * output it cannot parse changes nothing on screen except a Claude node wearing an alarming hint.
 */
const IGNORED_ADAPTER_DIAGNOSTICS = [/^claude auth status\b/i]

/**
 * The progress text one stderr chunk is worth: its lines minus the ignored diagnostics. A chunk can
 * carry several lines, so the filter is per line rather than per chunk, and a chunk left with
 * nothing publishes no status at all.
 */
export function startingProgressFrom(chunk: string): string | undefined {
  const kept = chunk
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !IGNORED_ADAPTER_DIAGNOSTICS.some((pattern) => pattern.test(line)))
  return kept.length > 0 ? kept.join('\n') : undefined
}

/** Normalizes a prompt submission (plain text, or a mix of text/image content blocks) into the ACP content-block array. */
export function toPromptBlocks(content: AgentPromptContent): AgentPromptBlock[] {
  return typeof content === 'string' ? [{ type: 'text', text: content }] : content
}

/**
 * The text of the user message main publishes for an accepted prompt: its text blocks, and only
 * those. Images stay desktop-local render state (`AgentChatMessage.images`) - a phone cannot attach
 * them and the snapshot should not carry their bytes - so an image-only prompt yields `''` and no
 * user message is published for it.
 */
export function promptText(content: AgentPromptContent): string {
  return toPromptBlocks(content)
    .filter((block): block is AgentPromptTextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
}

/**
 * Blocks `runPrompt` from sending an `image` content block to an agent whose `initialize`
 * handshake never advertised `promptCapabilities.image`. Pulled out as a pure function (mirroring
 * `promptGuard`) so the gating is directly testable without spinning up the full ACP connection.
 */
export function imageCapabilityGuard(
  running: { imageSupport: boolean },
  blocks: AgentPromptBlock[]
): AgentPromptResult | null {
  if (running.imageSupport) return null
  if (!blocks.some((block) => block.type === 'image')) return null
  return { ok: false, message: 'This agent does not support image attachments.' }
}

/**
 * Blocks `runPrompt` from re-attempting delivery while the agent is already parked in
 * `auth_required`. Pulled out as a pure function (mirroring `promptFailure`) so the
 * no-retry-storm behavior is directly testable without spinning up the full ACP connection.
 */
export function promptGuard(running: { authRequired: boolean }): AgentPromptResult | null {
  if (!running.authRequired) return null
  return { ok: false, message: 'Sign in to Claude to continue this conversation.' }
}

type SteeringResponse = { outcome?: 'injected' | 'startedNewTurn' | 'failed' }

/** Injects a queued message into an in-flight ACP turn via the adapter's steering extension. */
export async function deliverSteeredPrompt(
  request: (method: string, params: { sessionId: string; prompt: ContentBlock[] }) => Promise<SteeringResponse>,
  sessionId: string,
  content: AgentPromptContent
): Promise<AgentPromptResult> {
  try {
    const response = await request('_session/steering', {
      sessionId,
      prompt: toPromptBlocks(content) as ContentBlock[]
    })
    if (response.outcome === 'injected' || response.outcome === 'startedNewTurn') return { ok: true }
    return { ok: false, message: 'The agent could not accept the queued message.' }
  } catch (error) {
    return { ok: false, message: errorMessage(error) }
  }
}

/**
 * Why an answer to a pending request did not land. Both readings matter to a remote client: it
 * lost a race against another device (or against the desktop), or the session it was answering is
 * no longer running at all. The wording is what a phone shows verbatim.
 */
const REQUEST_ALREADY_ANSWERED: AgentPromptResult = {
  ok: false,
  message: 'That request was already answered.'
}
const SESSION_NOT_RUNNING: AgentPromptResult = { ok: false, message: 'This agent session is not running.' }

const LOGIN_URL_PATTERN = /https?:\/\/[^\s<>"')]+/

/** Pulls the OAuth sign-in URL out of a terminal-auth subprocess's stdout/stderr line (or an
 *  elicitation message), if it printed one, so Toucan can both auto-open it and offer a persistent,
 *  actionable link instead of relying solely on the CLI's own (not always reachable) browser
 *  launch. */
export function extractLoginUrl(text: string): string | undefined {
  return text.match(LOGIN_URL_PATTERN)?.[0]
}

/**
 * Sends one browser paste-back code to the terminal authentication helper without ever putting
 * the credential into an event, log, or command line. The trailing newline is the Enter key the
 * underlying Claude CLI is waiting for.
 */
export function writeAuthCode(input: Writable | undefined, code: string): Promise<AgentPromptResult> {
  const trimmed = code.trim()
  if (!trimmed) return Promise.resolve({ ok: false, message: 'Paste the sign-in code first.' })
  if (trimmed.length > 8_192 || /[\r\n]/.test(trimmed)) {
    return Promise.resolve({ ok: false, message: 'Paste one sign-in code without line breaks.' })
  }
  if (!input || !input.writable || input.destroyed || input.writableEnded) {
    return Promise.resolve({ ok: false, message: 'No sign-in process is waiting for a code.' })
  }
  return new Promise((resolve) => {
    try {
      input.write(`${trimmed}\n`, (error) =>
        resolve(error ? { ok: false, message: 'Toucan could not send the sign-in code.' } : { ok: true })
      )
    } catch {
      resolve({ ok: false, message: 'Toucan could not send the sign-in code.' })
    }
  })
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'object' && error !== null && typeof (error as { message?: unknown }).message === 'string')
    return (error as { message: string }).message
  return String(error)
}

/**
 * The ACP protocol's own `-32000` code is the primary signal, but the Claude adapter does not
 * always use it: an OAuth session that expires mid-turn (refresh failed) surfaces as a generic
 * `-32603` internal error whose `data.errorKind` is the SDK's own `"authentication_failed"`
 * marker (see `@anthropic-ai/claude-agent-sdk`'s `SDKAssistantMessageError` type and
 * `claude-agent-acp`'s `errorKindData` helper, which documents this as "a convention for ACP
 * clients to dispatch on without having to pattern-match the human-readable message text").
 * Without this check that failure fell through to the generic-error branch with no way to
 * re-authenticate, unlike every other auth-required case.
 */
function isAuthRequired(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  if ((error as { code?: unknown }).code === -32000) return true
  const data = (error as { data?: unknown }).data
  return (
    typeof data === 'object' && data !== null && (data as { errorKind?: unknown }).errorKind === 'authentication_failed'
  )
}

/** Filters out internal notification wrappers that leak into the chat view on session resume. */
export function isInternalNotificationText(text: string): boolean {
  const trimmed = text.trimStart()
  return trimmed.startsWith('<task-notification>') || trimmed.startsWith('<system-reminder>')
}

/**
 * Codex keeps progress commentary and the final answer in the same ACP update type, but preserves
 * the distinction in replay-stable adapter metadata. Claude does not currently advertise an
 * equivalent phase, so untagged assistant messages are classified at their turn boundary.
 */
function assistantPresentationFromMeta(meta: unknown): AgentMessagePresentation | undefined {
  if (typeof meta !== 'object' || meta === null) return undefined
  const codex = (meta as { codex?: unknown }).codex
  if (typeof codex !== 'object' || codex === null) return undefined
  const phase = (codex as { phase?: unknown }).phase
  if (phase === 'commentary') return 'progress'
  if (phase === 'final_answer') return 'final'
  return undefined
}

/**
 * Some adapter replay formats omit message IDs. During the finite `session/load` stream, adjacent
 * chunks with the same role/phase belong together; a role, phase, or non-message boundary starts a
 * new synthetic identity. Live traffic retains the long-standing per-role fallback because its turn
 * boundary is supplied separately by the prompt lifecycle.
 */
function messageIdForUpdate(
  running: RunningAgent,
  messageId: string | null | undefined,
  role: 'user' | 'assistant' | 'thought',
  presentation?: AgentMessagePresentation
): string {
  if (messageId) {
    running.replayMessageKey = undefined
    running.replayMessageId = undefined
    return messageId
  }
  if (!running.replayEvents) return `${role}-current`

  const key = `${role}:${presentation ?? 'unphased'}`
  if (running.replayMessageKey === key && running.replayMessageId) return running.replayMessageId

  const sequence = (running.replayMessageSequence ?? 0) + 1
  const syntheticId = `replay-${role}-${sequence}`
  running.replayMessageSequence = sequence
  running.replayMessageKey = key
  running.replayMessageId = syntheticId
  return syntheticId
}

function markReplayMessageBoundary(running: RunningAgent): void {
  if (!running.replayEvents) return
  running.replayMessageKey = undefined
  running.replayMessageId = undefined
}

function simplifyAuthMethod(method: AuthMethod): AgentAuthMethod {
  return {
    id: method.id,
    name: method.name,
    ...(method.description ? { description: method.description } : {}),
    type: 'type' in method ? method.type : 'agent',
    ...('args' in method && method.args ? { args: method.args } : {})
  }
}

/**
 * Narrows the protocol's `AvailableCommand` to what the composer's completion actually renders,
 * and drops anything unnamed so a malformed entry can never occupy a row nothing can insert.
 * `input` is what distinguishes a command that expects arguments from one that doesn't.
 */
export function simplifyAvailableCommands(commands: AvailableCommand[] | null | undefined): AgentCommand[] {
  if (!commands) return []
  return commands
    .filter((command) => typeof command.name === 'string' && command.name.length > 0)
    .map((command) => ({
      name: command.name,
      description: command.description ?? '',
      ...(command.input ? { input: { hint: command.input.hint ?? '' } } : {})
    }))
}

function simplifyModes(
  modes:
    | {
        currentModeId: string
        availableModes: Array<{ id: string; name: string; description?: string | null }>
      }
    | null
    | undefined
): AgentModeState | undefined {
  if (!modes) return undefined
  return {
    currentModeId: modes.currentModeId,
    availableModes: modes.availableModes.map((mode) => ({
      id: mode.id,
      name: mode.name,
      ...(mode.description ? { description: mode.description } : {})
    }))
  }
}

export interface AcpSessionManagerOptions {
  appPath: string
  /** Chosen once per process; running sessions and their auth launches keep that installation. */
  resolveAdapter?: (provider: AgentCreateRequest['provider']) => string
  codexHome?: string
  /** Environment inherited by both adapters and the provider processes they launch. */
  environment?: NodeJS.ProcessEnv
  /** Seam for tests to observe the launch the primary adapter is actually spawned with. */
  spawnAgent?: (launch: AgentProcessLaunch) => ChildProcessWithoutNullStreams
  /**
   * The fan-out every session publishes its `AgentEvent`s to. The creating renderer is only
   * subscriber #1; injecting the broker lets other hosts (the remote server) subscribe to the
   * same sessions and read the same live transcript snapshots.
   */
  broker?: AgentEventBroker
  /**
   * Told what a session just advertised as its available models, every time a session advertises
   * anything. The manager keeps this per running session already (`cachedModels`); this is the seam
   * that lets it outlive the session, which is the only way a surface choosing a model *before* a
   * session exists has anything to offer. Injected rather than owned so the manager keeps no disk
   * of its own - see `agent-model-catalogue-store.ts`.
   */
  onModelsAdvertised?: (provider: AgentProvider, models: readonly AgentModel[]) => void
  /**
   * The session outcome index, watching each session's fan-out for its turn boundaries. Injected
   * like the broker so the manager keeps no disk of its own, and optional because indexing is
   * observation: a session runs identically without it.
   */
  sessionOutcomes?: SessionOutcomeIndexer
}

/**
 * The environment an agent runs in. The node's identity travels with it so work the agent
 * starts outside Toucan's sight - a worktree it creates for itself - can name the node that
 * asked for it. One function builds it, because a node id that reaches only the record kept
 * beside the process and not the process itself is exactly as good as no node id at all.
 */
export function agentProcessEnvironment(environment: NodeJS.ProcessEnv, nodeId: string): NodeJS.ProcessEnv {
  return { ...environment, TOUCAN_NODE_ID: nodeId }
}

export function promptFailure(
  error: unknown,
  authMethods: AgentAuthMethod[],
  turnId: string
): { events: AgentEvent[]; result: AgentPromptResult } {
  const message = errorMessage(error)
  if (isAuthRequired(error)) {
    return {
      events: [
        { type: 'auth', methods: authMethods },
        { type: 'status', status: 'auth_required', message }
      ],
      result: { ok: false, message }
    }
  }
  return {
    events: [
      { type: 'turn_failed', turnId, message },
      { type: 'status', status: 'idle' }
    ],
    result: { ok: false, message }
  }
}

/**
 * Waits for the provider-owned ACP turn to reach its real terminal boundary. Elapsed wall-clock
 * time is deliberately absent: a long-running turn is still live until the provider completes,
 * rejects, exits, or the user explicitly cancels it.
 */
export async function settleAgentTurn(
  turnId: string,
  providerTurn: Promise<{ stopReason: string }>,
  authMethods: AgentAuthMethod[]
): Promise<{ events: AgentEvent[]; result: AgentPromptResult; authRequired: boolean }> {
  try {
    const response = await providerTurn
    return {
      events: [
        response.stopReason === 'cancelled'
          ? { type: 'turn_cancelled', turnId, message: 'Stopped by you.' }
          : { type: 'turn_complete', stopReason: response.stopReason },
        { type: 'status', status: 'idle' }
      ],
      result: { ok: true },
      authRequired: false
    }
  } catch (error) {
    return { ...promptFailure(error, authMethods, turnId), authRequired: isAuthRequired(error) }
  }
}

export interface AcpSessionManager {
  create(request: AgentCreateRequest, owner: WebContents): Promise<AgentCreateResult>
  prompt(id: string, content: AgentPromptContent): Promise<AgentPromptResult>
  /**
   * Accepts or refuses a prompt without waiting for the turn it starts. `prompt`'s promise settles
   * at the *end* of the turn, which is the wrong answer for a client asking "did my message get
   * through?" - a phone composer would hold its text for the whole turn and then read a failed
   * turn as a failed send. This reports delivery only; the turn reports itself through events.
   */
  startPrompt(id: string, content: AgentPromptContent): AgentPromptResult
  promptWhenIdle(id: string, content: AgentPromptContent): Promise<AgentPromptResult>
  setMode(id: string, modeId: string): Promise<AgentPromptResult>
  setModel(id: string, modelId: string): Promise<AgentPromptResult>
  setEffort(id: string, effortId: string): Promise<AgentPromptResult>
  authenticate(id: string, methodId: string): Promise<AgentCreateResult>
  submitAuthCode(id: string, code: string): Promise<AgentPromptResult>
  openAuthLink(url: string): Promise<void>
  /**
   * Answers a pending tool permission, and reports whether *this* answer is the one that landed.
   * The pending map is the race key: whichever client gets here first removes the entry and
   * resolves the provider's request, and every later answer for the same id is refused rather than
   * sent twice. The desktop ignores the verdict (it answered its own visible card); a remote
   * client needs it, which is why this reports instead of returning void.
   */
  resolveApproval(id: string, approvalId: string, optionId?: string): AgentPromptResult
  resolveElicitation(id: string, requestId: string, content?: AgentDecisionResponseContent): AgentPromptResult
  /**
   * Which live session recently changed which file, newest last per session. Toucan observes every
   * tool call anyway, so this is the one record of authorship it can keep; `ticket-steering.ts`
   * reads it to decide whose ticket file the board could not parse.
   */
  recentWrites(): AgentFileWrite[]
  cancel(id: string): void
  kill(id: string): void
  killOwned(owner: WebContents): void
  killAll(): void
}

/**
 * How many write locations one session is remembered by. Attribution only ever asks about a file
 * the watcher saw change moments ago, so this is a ring rather than a log: it has to outlast a
 * turn's worth of edits and nothing more, and a session editing a large tree must not grow a
 * record of every file it has ever touched.
 */
const RECENT_WRITE_LIMIT = 100

/**
 * Wall clock, but never twice the same value across every session in the process. `Date.now()` has
 * millisecond granularity and two sessions can report a write inside one of them, which would
 * leave "who wrote it last" decided by map iteration order rather than by arrival. Still a real
 * timestamp, because staleness is judged against it too.
 */
let lastWriteStamp = 0
function nextWriteStamp(): number {
  lastWriteStamp = Math.max(Date.now(), lastWriteStamp + 1)
  return lastWriteStamp
}

/**
 * Records the files one tool call changed, as evidence of who wrote them. Reads and searches
 * report `locations` too and are deliberately excluded (`isFileWritingToolKind`): having looked at
 * a file is not having produced it, and steering the wrong session about a file it only read is
 * worse than steering nobody. A shell redirect is the gap this leaves - neither adapter reports
 * `locations` for an `execute` call, so such a write is noticed but attributed to no session.
 *
 * Returns the absolute paths it recorded, so the session outcome index can accumulate its own
 * unbounded-by-the-ring write set off the same classification rather than duplicating it.
 */
function recordWrittenLocations(
  running: RunningAgent,
  update: { kind?: string | null; locations?: ReadonlyArray<{ path: string }> | null }
): string[] {
  if (!isFileWritingToolKind(update.kind) || !update.locations?.length) return []
  const at = nextWriteStamp()
  const written = update.locations.map((location) => resolve(running.request.cwd, location.path))
  for (const path of written) running.recentWrites.push({ path, at })
  if (running.recentWrites.length > RECENT_WRITE_LIMIT) {
    running.recentWrites.splice(0, running.recentWrites.length - RECENT_WRITE_LIMIT)
  }
  return written
}

export function createAcpSessionManager(options: AcpSessionManagerOptions): AcpSessionManager {
  const environment = options.environment ?? process.env
  const agents = new Map<string, RunningAgent>()
  /**
   * The model list the last Claude session advertised. The Claude worker has to be named before
   * `session/new` answers with the models, so the previous session's list is the only pre-launch
   * evidence there is; the first Claude session of a process launches on trust and is verified
   * against its own list once it opens.
   */
  /**
   * What the most recently opened Claude session listed as models: the only evidence available
   * before the next Claude launch. Process-wide by nature, so after an account switch it is stale
   * until the next Claude session opens and refreshes it.
   */
  let lastClaudeSessionModelIds: string[] | undefined
  const broker = options.broker ?? createAgentEventBroker()
  const toucanSkillsRoot = resolveToucanSkillsRoot(options.appPath)

  /**
   * The one place a session's advertised model list is written down. Every assignment to
   * `cachedModels` goes through here so that what outlives the session (the catalogue) cannot
   * drift from what the session itself believes - and so a fourth site added later inherits the
   * recording for free rather than silently skipping it.
   */
  const rememberModels = (running: RunningAgent, models: AgentModelState): AgentModelState => {
    running.cachedModels = models
    options.onModelsAdvertised?.(running.request.provider, models.availableModels)
    return models
  }

  const send = (running: RunningAgent, event: AgentEvent): void => {
    // A stopped session's channel is closed; a straggler (late stderr, a rejected in-flight
    // request) publishing after that would lazily resurrect a ghost channel nothing ever closes.
    if (running.stopping) return
    if (running.replayEvents) {
      // Replay stays off the live channel (it travels inside the create result), but the broker's
      // snapshot must still learn what it restored, or a late subscriber would miss the history.
      running.replayEvents.push(event)
      broker.fold(running.request.id, event)
      return
    }
    broker.publish(running.request.id, event)
  }

  const adapterPath = (provider: AgentCreateRequest['provider']): string =>
    join(
      options.appPath,
      'node_modules',
      '@agentclientprotocol',
      provider === 'codex' ? 'codex-acp' : 'claude-agent-acp',
      'dist',
      'index.js'
    )

  /** A conversation's saved model is a preference, so a rejected switch must not sink the session. */
  const applySavedModel = async (
    running: RunningAgent,
    models: AgentModelState
  ): Promise<{ models: AgentModelState; configOptions?: SessionConfigOption[] | null }> => {
    const modelId = running.request.modelId
    if (
      !running.modelConfigId ||
      !modelId ||
      modelId === models.currentModelId ||
      !models.availableModels.some((model) => model.id === modelId)
    )
      return { models }
    try {
      const response = await running.context.request(methods.agent.session.setConfigOption, {
        sessionId: running.sessionId!,
        configId: running.modelConfigId,
        value: modelId
      })
      return { models: { ...models, currentModelId: modelId }, configOptions: response.configOptions }
    } catch (error) {
      send(running, { type: 'error', message: `Could not select the saved model: ${errorMessage(error)}` })
      return { models }
    }
  }

  /** Applies a saved effort only when the active provider/model advertises that exact value. */
  const applySavedEffort = async (running: RunningAgent, efforts: AgentEffortState): Promise<AgentEffortState> => {
    const effortId = running.request.effortId
    if (
      !running.effortConfigId ||
      !effortId ||
      effortId === efforts.currentEffortId ||
      !efforts.availableEfforts.some((effort) => effort.id === effortId)
    )
      return efforts
    try {
      await running.context.request(methods.agent.session.setConfigOption, {
        sessionId: running.sessionId!,
        configId: running.effortConfigId,
        value: effortId
      })
      return { ...efforts, currentEffortId: effortId }
    } catch (error) {
      send(running, { type: 'error', message: `Could not select the saved effort: ${errorMessage(error)}` })
      return efforts
    }
  }

  /** Every create result also lands in the broker snapshot, mirroring the renderer's own fold. */
  const openSession = async (running: RunningAgent): Promise<AgentCreateResult> => {
    running.opening = true
    try {
      const result = await openProviderSession(running)
      broker.applyCreateResult(running.request.id, result)
      return result
    } finally {
      running.opening = false
    }
  }

  const openProviderSession = async (running: RunningAgent): Promise<AgentCreateResult> => {
    send(running, { type: 'status', status: 'starting' })
    try {
      let modes: AgentModeState | undefined
      let models: AgentModelState | undefined
      let efforts: AgentEffortState | undefined
      const configureOptions = (configOptions?: SessionConfigOption[] | null): void => {
        const modelSelector = modelSelectorFromConfigOptions(configOptions)
        running.modelConfigId = modelSelector?.configId
        models = modelSelector?.models
        const effortSelector = effortSelectorFromConfigOptions(configOptions)
        running.effortConfigId = effortSelector?.configId
        efforts = effortSelector?.efforts
      }
      const configure = (response: {
        modes?: Parameters<typeof simplifyModes>[0]
        configOptions?: SessionConfigOption[] | null
      }): void => {
        modes = simplifyModes(response.modes)
        configureOptions(response.configOptions)
      }
      const baseConfiguration = withAdditionalDirectories(
        sessionSkillsConfiguration(running.request.provider, running.request.cwd, toucanSkillsRoot),
        running.request.additionalDirectories
      )
      const skillsConfiguration =
        running.request.provider === 'claude' && running.routineDelegation?.status === 'configured'
          ? withClaudeDelegation(baseConfiguration, running.routineDelegation)
          : baseConfiguration
      let resumed = false
      let replay: AgentEvent[] | undefined
      if (running.request.sessionId) {
        replay = []
        running.replayEvents = replay
        running.replayMessageSequence = 0
        markReplayMessageBoundary(running)
        let response
        try {
          response = await running.context.request(methods.agent.session.load, {
            sessionId: running.request.sessionId,
            cwd: running.request.cwd,
            mcpServers: [],
            ...skillsConfiguration
          })
        } finally {
          running.replayEvents = undefined
        }
        running.sessionId = running.request.sessionId
        configure(response)
        resumed = true
      }
      if (!resumed) {
        const response = await running.context.request(methods.agent.session.new, {
          cwd: running.request.cwd,
          mcpServers: [],
          ...skillsConfiguration
        })
        running.sessionId = response.sessionId
        configure(response)
      }
      const sessionId = running.sessionId
      if (!sessionId) throw new Error('The agent did not return a session ID.')
      if (
        running.request.permissionMode &&
        modes?.availableModes.some((mode) => mode.id === running.request.permissionMode) &&
        modes.currentModeId !== running.request.permissionMode
      ) {
        await running.context.request(methods.agent.session.setMode, {
          sessionId,
          modeId: running.request.permissionMode
        })
        modes = { ...modes, currentModeId: running.request.permissionMode }
      }
      if (models) {
        const applied = await applySavedModel(running, models)
        models = applied.models
        if (applied.configOptions) configureOptions(applied.configOptions)
      }
      if (efforts) efforts = await applySavedEffort(running, efforts)
      if (models) rememberModels(running, models)
      if (efforts) running.cachedEfforts = efforts
      if (running.request.provider === 'claude' && models) {
        lastClaudeSessionModelIds = models.availableModels.map((model) => model.id)
        // The one check that could not happen before launch: a worker the session does not list
        // would be substituted by the CLI, so the record turns unavailable and says so.
        if (running.routineDelegation?.status === 'configured')
          running.routineDelegation = appliedClaudeDelegation(
            running.routineDelegation,
            lastClaudeSessionModelIds,
            environment
          )
      }
      running.authRequired = false
      send(running, { type: 'session', sessionId })
      if (modes) send(running, { type: 'modes', modes })
      if (models) send(running, { type: 'models', models })
      if (efforts) send(running, { type: 'efforts', efforts })
      // Reopening an existing agent never replays the notification that first advertised these.
      if (running.cachedCommands?.length) send(running, { type: 'commands', commands: running.cachedCommands })
      send(running, { type: 'status', status: 'ready' })
      return {
        ok: true,
        status: 'ready',
        sessionId,
        imageSupport: running.imageSupport,
        ...(modes ? { modes } : {}),
        ...(models ? { models } : {}),
        ...(efforts ? { efforts } : {}),
        ...(running.cachedCommands?.length ? { commands: running.cachedCommands } : {}),
        ...(running.routineDelegation ? { routineDelegation: running.routineDelegation } : {}),
        ...(replay?.length ? { replay } : {})
      }
    } catch (error) {
      if (isAuthRequired(error)) {
        running.authRequired = true
        const models = running.cachedModels
        const efforts = running.cachedEfforts
        send(running, { type: 'auth', methods: running.authMethods })
        if (models) send(running, { type: 'models', models })
        if (efforts) send(running, { type: 'efforts', efforts })
        send(running, { type: 'status', status: 'auth_required' })
        return {
          ok: false,
          status: 'auth_required',
          authMethods: running.authMethods,
          imageSupport: running.imageSupport,
          ...(models ? { models } : {}),
          ...(efforts ? { efforts } : {}),
          ...(running.routineDelegation ? { routineDelegation: running.routineDelegation } : {})
        }
      }
      const message = errorMessage(error)
      send(running, { type: 'error', message })
      return { ok: false, status: 'error', message }
    }
  }

  const stop = (id: string): void => {
    // Unconditional: an unexpectedly exited agent is already out of `agents`, but its channel
    // (snapshot and subscribers, the owner's forwarding among them) must still be retired, or the
    // renderer's kill-then-recreate cycle would stack a second owner subscription per restart.
    broker.close(id)
    const running = agents.get(id)
    if (!running) return
    running.wakeGate?.dispose()
    running.stopping = true
    for (const pending of running.pendingApprovals.values()) {
      pending.resolve({ outcome: { outcome: 'cancelled' } })
    }
    running.pendingApprovals.clear()
    for (const pending of running.pendingElicitations.values()) pending.resolve({ action: 'cancel' })
    running.pendingElicitations.clear()
    running.authChild?.kill()
    running.connection.close()
    running.process.kill()
    agents.delete(id)
  }

  /**
   * Splits a prompt into its two genuinely different moments: whether the session *accepts* it,
   * which is decided synchronously here, and how the resulting turn ends, which can be minutes
   * later. Callers that want a delivery acknowledgement (`startPrompt`) must not be made to wait
   * for a turn outcome, and callers that want the outcome (`prompt`) must not have to re-derive
   * acceptance - so both read this one decision. Marking the session busy is part of accepting,
   * and it happens before this returns, so two concurrent prompts cannot both be accepted.
   */
  const beginTurn = (
    id: string,
    content: AgentPromptContent
  ): { refusal: AgentPromptResult } | { turn: Promise<AgentPromptResult> } => {
    const running = agents.get(id)
    if (!running?.sessionId) return { refusal: { ok: false, message: 'The agent session is not ready.' } }
    const guard = promptGuard(running)
    if (guard) return { refusal: guard }
    if (running.busy) return { refusal: { ok: false, message: 'The agent session is busy.' } }
    const blocks = toPromptBlocks(content)
    const imageGuard = imageCapabilityGuard(running, blocks)
    if (imageGuard) return { refusal: imageGuard }
    running.busy = true
    publishUserMessage(running, content)
    send(running, { type: 'status', status: 'working' })
    return { turn: settleTurn(running, running.sessionId, blocks) }
  }

  /**
   * Main is the author of the user message. Neither adapter replays a live prompt back as a
   * `user_message_chunk` (only `session/load` does), and the desktop's own bubble is renderer-local
   * state no other client can see - so the one place every accepted prompt passes through, whatever
   * its origin (renderer IPC, the remote socket), publishes it once to the broker. It is published
   * at acceptance, ahead of `status: 'working'`, so every host folds it into the same transcript
   * position; the desktop consumes it as the echo of its optimistic bubble (`pendingSentRef`).
   */
  const publishUserMessage = (running: RunningAgent, content: AgentPromptContent): void => {
    const text = promptText(content)
    if (text.length === 0) return
    send(running, { type: 'message', role: 'user', messageId: crypto.randomUUID(), text })
  }

  const settleTurn = async (
    running: RunningAgent,
    sessionId: string,
    blocks: AgentPromptBlock[]
  ): Promise<AgentPromptResult> => {
    try {
      const turn = await settleAgentTurn(
        crypto.randomUUID(),
        running.context.request(methods.agent.session.prompt, {
          sessionId,
          prompt: blocks as ContentBlock[]
        }),
        running.authMethods
      )
      if (turn.authRequired) running.authRequired = true
      for (const event of turn.events) send(running, event)
      return turn.result
    } finally {
      running.busy = false
      running.wakeGate?.flush()
    }
  }

  const runPrompt = async (id: string, content: AgentPromptContent): Promise<AgentPromptResult> => {
    const started = beginTurn(id, content)
    return 'refusal' in started ? started.refusal : started.turn
  }

  return {
    async create(request, owner): Promise<AgentCreateResult> {
      const existing = agents.get(request.id)
      if (existing) return openSession(existing)

      let path: string
      try {
        path = options.resolveAdapter?.(request.provider) ?? adapterPath(request.provider)
      } catch (error) {
        return { ok: false, status: 'error', message: error instanceof Error ? error.message : String(error) }
      }
      if (!existsSync(path)) {
        return { ok: false, status: 'error', message: `The ${request.provider} ACP adapter is not installed.` }
      }

      // Subscriber #1: the creating renderer, receiving the same fanned-out stream any other
      // client would. Retired with the session by `stop`'s broker.close.
      broker.subscribe(request.id, (event) => {
        if (!owner.isDestroyed()) owner.send(AGENT_CHANNELS.event, { id: request.id, event })
      })

      // Subscriber #2 where the index is wired: another reader of the same stream, retired by the
      // same `broker.close`. Its context is read per boundary rather than captured here, because
      // the provider's conversation id only exists once the session has opened.
      const outcomeWatch = options.sessionOutcomes?.watch(request.id, () => {
        const running = agents.get(request.id)
        return running
          ? {
              provider: running.request.provider,
              conversationId: running.sessionId ?? null,
              projectPath: running.request.cwd
            }
          : null
      })

      // Read before launch: the delegation policy consults the same account model cache the
      // pre-auth model list is seeded from, and the policy travels only in the launch environment.
      const cachedModels =
        request.provider === 'codex' && options.codexHome
          ? readCachedCodexModels(options.codexHome, request.modelId)
          : undefined
      const delegation = !request.routineDelegation
        ? undefined
        : request.provider === 'codex'
          ? appliedCodexDelegation(
              request.routineDelegation,
              cachedModels?.availableModels.map((model) => model.id)
            )
          : appliedClaudeDelegation(request.routineDelegation, lastClaudeSessionModelIds, environment)
      const baseEnvironment = agentProcessEnvironment(environment, request.id)
      const agentEnvironment =
        request.provider === 'codex' && delegation?.status === 'configured'
          ? withCodexDelegationEnvironment(baseEnvironment, delegation)
          : baseEnvironment
      const launch = buildAgentProcessLaunch(process.execPath, path, request.cwd, agentEnvironment)
      const child = (options.spawnAgent ?? spawnAgentProcess)(launch)
      const pendingApprovals = new Map<string, PendingApproval>()
      const pendingElicitations = new Map<string, PendingElicitation>()
      let running: RunningAgent
      const app = client({ name: 'Toucan ACP prototype' })
        .onNotification(methods.client.session.update, ({ params }) => {
          const update = params.update
          if (
            update.sessionUpdate !== 'user_message_chunk' &&
            update.sessionUpdate !== 'agent_message_chunk' &&
            update.sessionUpdate !== 'agent_thought_chunk'
          )
            markReplayMessageBoundary(running)
          if (
            update.sessionUpdate === 'user_message_chunk' &&
            update.content.type === 'text' &&
            // Only `session/load` replay may author user messages from the adapter's side: a live
            // one would be a second copy of the prompt `publishUserMessage` already published for
            // this turn, and dropping it here spares every client a dedupe of its own.
            running.replayEvents &&
            !isInternalNotificationText(update.content.text)
          ) {
            send(running, {
              type: 'message',
              role: 'user',
              messageId: messageIdForUpdate(running, update.messageId, 'user'),
              text: update.content.text
            })
          } else if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
            const presentation = assistantPresentationFromMeta(update._meta)
            send(running, {
              type: 'message',
              role: 'assistant',
              messageId: messageIdForUpdate(running, update.messageId, 'assistant', presentation),
              text: update.content.text,
              ...(presentation ? { presentation } : {})
            })
          } else if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'image') {
            // An assistant's own picture arrives as a chunk of the same message its prose does,
            // just with `image` content - so it folds onto that message rather than becoming one
            // of its own, and contributes no text (issue #174).
            const presentation = assistantPresentationFromMeta(update._meta)
            send(running, {
              type: 'message',
              role: 'assistant',
              messageId: messageIdForUpdate(running, update.messageId, 'assistant', presentation),
              text: '',
              images: [imageContentFrom(update.content)],
              ...(presentation ? { presentation } : {})
            })
          } else if (update.sessionUpdate === 'agent_thought_chunk' && update.content.type === 'text') {
            send(running, {
              type: 'message',
              role: 'thought',
              messageId: messageIdForUpdate(running, update.messageId, 'thought'),
              text: update.content.text
            })
          } else if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
            // Recorded first and forwarded second: `a?.b(f())` would skip `f()` entirely whenever
            // no index is wired, taking the session's own write attribution down with it.
            const written = recordWrittenLocations(running, update)
            if (written.length) running.sessionOutcomes?.recordWrites(written)
            send(running, { type: 'activity', activity: activityFromUpdate(update) })
          } else if (update.sessionUpdate === 'plan') {
            send(running, { type: 'plan', entries: update.entries })
          } else if (update.sessionUpdate === 'current_mode_update') {
            send(running, {
              type: 'modes',
              modes: {
                currentModeId: update.currentModeId,
                availableModes: []
              }
            })
          } else if (update.sessionUpdate === 'config_option_update') {
            const modelSelector = modelSelectorFromConfigOptions(update.configOptions)
            if (modelSelector) {
              running.modelConfigId = modelSelector.configId
              rememberModels(running, modelSelector.models)
              send(running, { type: 'models', models: modelSelector.models })
            }
            const effortSelector = effortSelectorFromConfigOptions(update.configOptions)
            if (effortSelector) {
              running.effortConfigId = effortSelector.configId
              running.cachedEfforts = effortSelector.efforts
              send(running, { type: 'efforts', efforts: effortSelector.efforts })
            } else if (running.effortConfigId || running.cachedEfforts) {
              running.effortConfigId = undefined
              running.cachedEfforts = undefined
              send(running, { type: 'efforts', efforts: null })
            }
          } else if (update.sessionUpdate === 'available_commands_update') {
            running.cachedCommands = simplifyAvailableCommands(update.availableCommands)
            send(running, { type: 'commands', commands: running.cachedCommands })
          } else if (update.sessionUpdate === 'usage_update') {
            send(running, {
              type: 'usage',
              used: update.used,
              size: update.size,
              ...(update.cost ? { cost: { amount: update.cost.amount, currency: update.cost.currency } } : {})
            })
          }
        })
        .onRequest(methods.client.session.requestPermission, ({ params }) => {
          const approvalId = crypto.randomUUID()
          const options: AgentPermissionOption[] = params.options.map((option) => ({
            id: option.optionId,
            label: option.name,
            kind: option.kind
          }))
          send(running, {
            type: 'approval',
            approvalId,
            title: agentPermissionTitle(params.toolCall),
            options,
            activity: activityFromUpdate(params.toolCall)
          })
          return new Promise((resolve) => pendingApprovals.set(approvalId, { resolve }))
        })
        .onRequest(methods.client.elicitation.create, async ({ params }) => {
          const elicitation = params as CreateElicitationRequest
          if (elicitation.mode === 'url' && 'url' in elicitation && typeof elicitation.url === 'string') {
            await shell.openExternal(elicitation.url)
            send(running, { type: 'status', status: 'starting', message: elicitation.message })
            send(running, { type: 'auth_link', url: elicitation.url })
            return { action: 'accept' as const }
          }
          if (elicitation.mode === 'form' && 'requestedSchema' in elicitation) {
            const questions = decisionQuestions(elicitation)
            if (questions.length === 0) return { action: 'decline' as const }
            const requestId = crypto.randomUUID()
            send(running, {
              type: 'decision_request',
              request: { id: requestId, message: elicitation.message, questions }
            })
            return new Promise((resolve) => pendingElicitations.set(requestId, { resolve }))
          }
          return { action: 'decline' as const }
        })

      const stream = ndJsonStream(
        Writable.toWeb(child.stdin) as unknown as WritableStream<Uint8Array>,
        Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>
      )
      const connection = app.connect(stream)
      running = {
        request,
        owner,
        process: child,
        connection,
        context: connection.agent,
        adapterPath: path,
        authMethods: [],
        // The very environment the adapter was launched with, so a terminal sign-in re-launch
        // and the running adapter cannot disagree about who this node is.
        environment: agentEnvironment,
        ...(delegation ? { routineDelegation: delegation } : {}),
        cachedModels,
        pendingApprovals,
        pendingElicitations,
        recentWrites: [],
        ...(outcomeWatch ? { sessionOutcomes: outcomeWatch } : {}),
        busy: false,
        stopping: false,
        authRequired: false,
        opening: true,
        imageSupport: false,
        steeringSupport: false
      }
      running.wakeGate = createPromptWakeGate<AgentPromptContent>({
        deliver: (content) => runPrompt(request.id, content)
      })
      agents.set(request.id, running)

      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (data: string) => {
        // Only the opening phase reports stderr as progress; see `RunningAgent.opening`.
        if (!running.opening) return
        const message = startingProgressFrom(data)
        if (message) send(running, { type: 'status', status: 'starting', message })
      })
      child.on('exit', (code) => {
        if (agents.get(request.id) === running) agents.delete(request.id)
        if (!running.stopping) {
          send(running, {
            type: 'status',
            status: 'exited',
            message: `ACP adapter exited with code ${code ?? 'unknown'}.`
          })
        }
      })

      try {
        const initialized = await running.context.request(methods.agent.initialize, {
          protocolVersion: 1,
          clientCapabilities: {
            auth: { terminal: true },
            elicitation: { form: {}, url: {} },
            plan: {},
            // Not ACP's `terminal` capability (which would make us host live terminals for the
            // agent): this `_meta` flag is what both adapters gate their `terminal_output` /
            // `terminal_exit` notifications on. Without it claude-agent-acp folds a Bash result
            // into a fenced code block and reports no exit code at all, and the shell tool card
            // has nothing to show but prose. See `terminalChunkOf` in `shared/agent-activity.ts`.
            _meta: { terminal_output: true }
          },
          clientInfo: { name: 'toucan', title: 'Toucan', version: '0.1.0' }
        })
        running.authMethods = (initialized.authMethods ?? []).map(simplifyAuthMethod)
        running.imageSupport = initialized.agentCapabilities?.promptCapabilities?.image ?? false
        const initializeMeta = initialized._meta as { steering?: { supported?: boolean } } | undefined
        running.steeringSupport = initializeMeta?.steering?.supported === true
        return await openSession(running)
      } catch (error) {
        const message = errorMessage(error)
        send(running, { type: 'error', message })
        stop(request.id)
        return { ok: false, status: 'error', message }
      }
    },

    prompt: runPrompt,

    startPrompt(id, content): AgentPromptResult {
      const started = beginTurn(id, content)
      if ('refusal' in started) return started.refusal
      // Nothing awaits the turn: its outcome reaches every subscriber - the desktop renderer and
      // any remote client - as `turn_complete`/`turn_failed` events on the broker, which is where
      // a caller that only sent a message should be reading it from anyway.
      void started.turn.catch(() => {
        /* Every failure mode already reported itself as an event; there is no second channel. */
      })
      return { ok: true }
    },

    async promptWhenIdle(id: string, content: AgentPromptContent): Promise<AgentPromptResult> {
      const running = agents.get(id)
      if (!running?.sessionId) return { ok: false, message: 'The agent session is not ready.' }
      if (!running.wakeGate) return runPrompt(id, content)
      if (!running.busy) return runPrompt(id, content)
      if (running.steeringSupport) {
        const result = await deliverSteeredPrompt(
          (method, params) => running.context.request<SteeringResponse, typeof params>(method, params),
          running.sessionId,
          content
        )
        // Injected into the turn in flight, so accepted here rather than through `beginTurn` - and
        // only once the adapter has said so, since a published message cannot be taken back. The
        // cost is that assistant text streamed during that round trip lands ahead of it in the
        // shared transcript, where the desktop's optimistic bubble sits before it.
        if (result.ok) publishUserMessage(running, content)
        return result
      }
      return running.wakeGate.enqueue(content)
    },

    async setMode(id, modeId): Promise<AgentPromptResult> {
      const running = agents.get(id)
      if (!running?.sessionId) return { ok: false, message: 'The agent session is not ready.' }
      try {
        await running.context.request(methods.agent.session.setMode, {
          sessionId: running.sessionId,
          modeId
        })
        return { ok: true }
      } catch (error) {
        const message = errorMessage(error)
        send(running, { type: 'error', message })
        return { ok: false, message }
      }
    },

    async setModel(id, modelId): Promise<AgentPromptResult> {
      const running = agents.get(id)
      if (!running) return { ok: false, message: 'The agent session is not running.' }
      if (!running.sessionId) {
        if (!running.cachedModels?.availableModels.some((model) => model.id === modelId)) {
          return { ok: false, message: 'That model is unavailable.' }
        }
        running.request.modelId = modelId
        send(running, {
          type: 'models',
          models: rememberModels(running, { ...running.cachedModels, currentModelId: modelId })
        })
        return { ok: true }
      }
      if (!running.modelConfigId) return { ok: false, message: 'This agent does not expose model selection.' }
      // Refused mid-turn, and refused *here* so both surfaces inherit one rule rather than each
      // greying out its own picker. Two things are wrong with swapping models under a running
      // turn. The provider's prompt cache is model-scoped, so the next request re-reads the whole
      // conversation uncached; worse, a thinking block is bound to the model that produced it, so
      // the incoming model picks the turn up without the reasoning behind the tool calls already
      // in it. Waiting for the boundary costs nothing - the turn is what is about to end anyway.
      if (running.busy) return { ok: false, message: MODEL_CHANGE_WHILE_BUSY }
      try {
        const response = await running.context.request(methods.agent.session.setConfigOption, {
          sessionId: running.sessionId,
          configId: running.modelConfigId,
          value: modelId
        })
        // Setting a model can reshape the agent's other selectors (effort levels, fast mode).
        const modelSelector = modelSelectorFromConfigOptions(response.configOptions)
        if (modelSelector) running.modelConfigId = modelSelector.configId
        // An accepted change is *always* published, exactly as an accepted effort change is. An
        // adapter that answers without restating its config options has still changed the model,
        // and a client with no renderer-local fold of its own - the phone - would otherwise be left
        // rendering the old one against a session running the new one, which is this selector's
        // whole failure mode (#185). The advertised list is carried over from the cache, since a
        // response that said nothing about the options did not retire any of them either.
        const models =
          modelSelector?.models ??
          (running.cachedModels ? { ...running.cachedModels, currentModelId: modelId } : undefined)
        if (models) {
          rememberModels(running, models)
          send(running, { type: 'models', models })
        }
        const effortSelector = effortSelectorFromConfigOptions(response.configOptions)
        if (effortSelector) {
          running.effortConfigId = effortSelector.configId
          running.cachedEfforts = effortSelector.efforts
          send(running, { type: 'efforts', efforts: effortSelector.efforts })
        } else {
          running.effortConfigId = undefined
          running.cachedEfforts = undefined
          send(running, { type: 'efforts', efforts: null })
        }
        running.request.modelId = modelId
        return { ok: true }
      } catch (error) {
        const message = errorMessage(error)
        send(running, { type: 'error', message })
        return { ok: false, message }
      }
    },

    async setEffort(id, effortId): Promise<AgentPromptResult> {
      const running = agents.get(id)
      if (!running?.sessionId) return { ok: false, message: 'The agent session is not ready.' }
      if (!running.effortConfigId || !running.cachedEfforts) {
        return { ok: false, message: 'This agent does not expose effort selection.' }
      }
      if (!running.cachedEfforts.availableEfforts.some((effort) => effort.id === effortId)) {
        return { ok: false, message: 'That effort is unavailable for the selected model.' }
      }
      try {
        const response = await running.context.request(methods.agent.session.setConfigOption, {
          sessionId: running.sessionId,
          configId: running.effortConfigId,
          value: effortId
        })
        const selector = effortSelectorFromConfigOptions(response.configOptions)
        const efforts = selector?.efforts ?? { ...running.cachedEfforts, currentEffortId: effortId }
        if (selector) running.effortConfigId = selector.configId
        running.request.effortId = effortId
        running.cachedEfforts = efforts
        send(running, { type: 'efforts', efforts })
        return { ok: true }
      } catch (error) {
        const message = errorMessage(error)
        send(running, { type: 'error', message })
        return { ok: false, message }
      }
    },

    async authenticate(id, methodId): Promise<AgentCreateResult> {
      const running = agents.get(id)
      if (!running) return { ok: false, status: 'error', message: 'The agent session is not running.' }
      const method = running.authMethods.find((candidate) => candidate.id === methodId)
      if (!method) return { ok: false, status: 'error', message: 'That authentication method is unavailable.' }
      if (running.authChild) {
        return { ok: false, status: 'error', message: 'A sign-in attempt is already in progress.' }
      }
      send(running, { type: 'status', status: 'starting', message: `Signing in with ${method.name}...` })
      try {
        if (method.type === 'terminal') {
          await new Promise<void>((resolve, reject) => {
            const launch =
              running.authProcess?.(method.args ?? []) ??
              buildAgentProcessLaunch(
                process.execPath,
                running.adapterPath,
                running.request.cwd,
                running.environment,
                method.args
              )
            const auth = spawnAgentProcess(launch)
            running.authChild = auth
            running.authInput = auth.stdin
            auth.stdout.setEncoding('utf8')
            auth.stderr.setEncoding('utf8')
            const report = (data: string): void => {
              const message = data.trim()
              if (!message) return
              send(running, { type: 'status', status: 'starting', message })
              // The CLI's own browser launch isn't reliable in every environment (e.g. a
              // headless/WSL desktop with no configured URL handler); open the link ourselves
              // via Electron's cross-platform `shell.openExternal` too, and surface it as a
              // persistent, actionable `auth_link` so the sign-in affordance survives even if
              // this status line gets overwritten by the next chunk of CLI output.
              const url = extractLoginUrl(message)
              if (url) {
                void shell.openExternal(url)
                send(running, { type: 'auth_link', url })
              }
            }
            auth.stdout.on('data', report)
            auth.stderr.on('data', report)
            auth.once('error', reject)
            auth.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`Login exited with code ${code}.`))))
          })
        } else {
          await running.context.request(methods.agent.authenticate, { methodId })
        }
        return await openSession(running)
      } catch (error) {
        const message = errorMessage(error)
        send(running, { type: 'error', message })
        return { ok: false, status: 'error', message }
      } finally {
        running.authChild = undefined
        running.authInput = undefined
      }
    },

    submitAuthCode(id, code): Promise<AgentPromptResult> {
      return writeAuthCode(agents.get(id)?.authInput, code)
    },

    async openAuthLink(url): Promise<void> {
      await shell.openExternal(url)
    },

    resolveApproval(id, approvalId, optionId): AgentPromptResult {
      const running = agents.get(id)
      if (!running) return SESSION_NOT_RUNNING
      const pending = running.pendingApprovals.get(approvalId)
      if (!pending) return REQUEST_ALREADY_ANSWERED
      running.pendingApprovals.delete(approvalId)
      pending.resolve({
        outcome: optionId ? { outcome: 'selected', optionId } : { outcome: 'cancelled' }
      })
      // Whoever answered, every subscriber must see the pending approval retire.
      send(running, { type: 'approval_resolved', approvalId })
      return { ok: true }
    },

    resolveElicitation(id, requestId, content): AgentPromptResult {
      const running = agents.get(id)
      if (!running) return SESSION_NOT_RUNNING
      const pending = running.pendingElicitations.get(requestId)
      if (!pending) return REQUEST_ALREADY_ANSWERED
      running.pendingElicitations.delete(requestId)
      pending.resolve(content ? { action: 'accept', content } : { action: 'cancel' })
      send(running, { type: 'decision_resolved', requestId })
      return { ok: true }
    },

    recentWrites: () =>
      [...agents].flatMap(([agentId, running]) => running.recentWrites.map(({ path, at }) => ({ agentId, path, at }))),

    cancel(id): void {
      const running = agents.get(id)
      if (!running?.sessionId) return
      // Stop is also an explicit queue reconciliation boundary for adapters without steering.
      // The active prompt's finally drains pre-existing messages after cancellation settles.
      running.wakeGate?.checkpoint(true)
      void running.context.notify(methods.agent.session.cancel, { sessionId: running.sessionId })
    },

    kill: stop,
    killOwned(owner): void {
      for (const [id, running] of agents) if (running.owner === owner) stop(id)
    },
    killAll(): void {
      for (const id of [...agents.keys()]) stop(id)
    }
  }
}

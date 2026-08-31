import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
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
  type RequestPermissionResponse,
  type SessionConfigOption
} from '@agentclientprotocol/sdk'
import type {
  AgentAuthMethod,
  AgentCommand,
  AgentCreateRequest,
  AgentCreateResult,
  AgentEffortState,
  AgentEvent,
  AgentModeState,
  AgentModelState,
  AgentPermissionOption,
  AgentPromptBlock,
  AgentPromptContent,
  AgentPromptResult
} from '../shared/agent'
import { activityFromUpdate } from '../shared/agent-activity'
import { agentPermissionTitle } from '../shared/agent-permission'
import { effortSelectorFromConfigOptions } from '../shared/agent-effort'
import { modelSelectorFromConfigOptions } from '../shared/agent-models'
import { StallTimeoutError, withStallGuard } from '../shared/stall-guard'
import { buildAgentProcessLaunch, type AgentProcessLaunch } from './agent-process'
import { readCachedCodexModels } from './codex-model-cache'
import { createPromptWakeGate, type PromptWakeGate } from './prompt-wake-gate'

interface PendingApproval {
  resolve(response: RequestPermissionResponse): void
}

/** The repository directory holding project-local skills, shared by both agents. */
const PROJECT_SKILLS_DIRECTORY = '.agents'

/**
 * Project-local skills stay in the repository; ADE never installs into the user's global
 * agent configuration. Codex discovers `<cwd>/.agents/skills` on its own, so only Claude
 * needs the directory handed to it - as a session-scoped inline plugin, which the ACP
 * adapter forwards from `_meta` straight into the SDK's `plugins` option.
 */
function projectSkillsMeta(
  provider: AgentCreateRequest['provider'],
  cwd: string
): { _meta: { claudeCode: { options: { plugins: Array<{ type: 'local'; path: string }> } } } } | undefined {
  if (provider !== 'claude') return undefined
  const path = join(cwd, PROJECT_SKILLS_DIRECTORY)
  if (!existsSync(join(path, 'skills'))) return undefined
  return { _meta: { claudeCode: { options: { plugins: [{ type: 'local', path }] } } } }
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
  pendingApprovals: Map<string, PendingApproval>
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
  wakeGate?: PromptWakeGate<AgentPromptContent>
}

/** Normalizes a prompt submission (plain text, or a mix of text/image content blocks) into the ACP content-block array. */
export function toPromptBlocks(content: AgentPromptContent): AgentPromptBlock[] {
  return typeof content === 'string' ? [{ type: 'text', text: content }] : content
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

const LOGIN_URL_PATTERN = /https?:\/\/[^\s<>"')]+/

/** Pulls the OAuth sign-in URL out of a terminal-auth subprocess's stdout/stderr line (or an
 *  elicitation message), if it printed one, so ADE can both auto-open it and offer a persistent,
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
        resolve(error ? { ok: false, message: 'ADE could not send the sign-in code.' } : { ok: true })
      )
    } catch {
      resolve({ ok: false, message: 'ADE could not send the sign-in code.' })
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

/**
 * A single ACP `session/prompt` call spans the agent's entire turn (every tool call it makes
 * until it reports a `stopReason`), so this has to be generous enough not to cut off a
 * legitimately long multi-step turn. It exists only to bound the pathological case: the
 * subprocess or its ACP connection stalls outright (a dropped stream, a deadlock, a
 * tool-permission approval request that never surfaces) and the call neither resolves nor
 * rejects. Without this, `runPrompt` awaits forever, `busy` never clears, and the renderer's
 * status indicator is stuck on "Working" with no way to recover short of killing the session.
 */
export const DEFAULT_TURN_TIMEOUT_MS = 10 * 60_000

/**
 * A stall timeout only means the *await* gave up; the agent side may still be processing the
 * original turn. Sending `session/cancel` is fire-and-forget (ACP notifications have no reply),
 * so this grace window is a heuristic buffer between that send and clearing `busy`/flushing the
 * wake gate, giving the agent a moment to actually abort before a fresh `session/prompt` for the
 * same session id can be dispatched behind it.
 */
export const DEFAULT_STALL_CANCEL_GRACE_MS = 250

export interface AcpSessionManagerOptions {
  appPath: string
  codexHome?: string
  /** Overrides `DEFAULT_TURN_TIMEOUT_MS`; primarily for tests. */
  turnTimeoutMs?: number
  /** Overrides `DEFAULT_STALL_CANCEL_GRACE_MS`; primarily for tests. */
  stallCancelGraceMs?: number
}

export function promptFailure(
  error: unknown,
  authMethods: AgentAuthMethod[]
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
      { type: 'error', message },
      { type: 'status', status: 'idle' }
    ],
    result: { ok: false, message }
  }
}

export interface AcpSessionManager {
  create(request: AgentCreateRequest, owner: WebContents): Promise<AgentCreateResult>
  prompt(id: string, content: AgentPromptContent): Promise<AgentPromptResult>
  promptWhenIdle(id: string, content: AgentPromptContent): Promise<AgentPromptResult>
  setMode(id: string, modeId: string): Promise<AgentPromptResult>
  setModel(id: string, modelId: string): Promise<AgentPromptResult>
  setEffort(id: string, effortId: string): Promise<AgentPromptResult>
  authenticate(id: string, methodId: string): Promise<AgentCreateResult>
  submitAuthCode(id: string, code: string): Promise<AgentPromptResult>
  openAuthLink(url: string): Promise<void>
  resolveApproval(id: string, approvalId: string, optionId?: string): void
  cancel(id: string): void
  kill(id: string): void
  killOwned(owner: WebContents): void
  killAll(): void
}

export function createAcpSessionManager(options: AcpSessionManagerOptions): AcpSessionManager {
  const agents = new Map<string, RunningAgent>()

  const send = (running: RunningAgent, event: AgentEvent): void => {
    if (running.replayEvents) {
      running.replayEvents.push(event)
      return
    }
    if (!running.owner.isDestroyed()) running.owner.send('agent:event', { id: running.request.id, event })
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

  const openSession = async (running: RunningAgent): Promise<AgentCreateResult> => {
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
      const skillsMeta = projectSkillsMeta(running.request.provider, running.request.cwd)
      let resumed = false
      let replay: AgentEvent[] | undefined
      if (running.request.sessionId) {
        replay = []
        running.replayEvents = replay
        let response
        try {
          response = await running.context.request(methods.agent.session.load, {
            sessionId: running.request.sessionId,
            cwd: running.request.cwd,
            mcpServers: [],
            ...skillsMeta
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
          ...skillsMeta
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
      if (models) running.cachedModels = models
      if (efforts) running.cachedEfforts = efforts
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
          ...(efforts ? { efforts } : {})
        }
      }
      const message = errorMessage(error)
      send(running, { type: 'error', message })
      return { ok: false, status: 'error', message }
    }
  }

  const stop = (id: string): void => {
    const running = agents.get(id)
    if (!running) return
    running.wakeGate?.dispose()
    running.stopping = true
    for (const pending of running.pendingApprovals.values()) {
      pending.resolve({ outcome: { outcome: 'cancelled' } })
    }
    running.pendingApprovals.clear()
    running.authChild?.kill()
    running.connection.close()
    running.process.kill()
    agents.delete(id)
  }

  const runPrompt = async (id: string, content: AgentPromptContent): Promise<AgentPromptResult> => {
    const running = agents.get(id)
    if (!running?.sessionId) return { ok: false, message: 'The agent session is not ready.' }
    const guard = promptGuard(running)
    if (guard) return guard
    if (running.busy) return { ok: false, message: 'The agent session is busy.' }
    const blocks = toPromptBlocks(content)
    const imageGuard = imageCapabilityGuard(running, blocks)
    if (imageGuard) return imageGuard
    running.busy = true
    send(running, { type: 'status', status: 'working' })
    const turnTimeoutMs = options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS
    try {
      const response = await withStallGuard(
        running.context.request(methods.agent.session.prompt, {
          sessionId: running.sessionId,
          prompt: blocks as ContentBlock[]
        }),
        turnTimeoutMs,
        `The agent did not respond within ${turnTimeoutMs}ms; the turn may be wedged (a stalled ` +
          'subprocess, a dropped ACP connection, or a tool-permission approval that never surfaced).'
      )
      send(running, { type: 'turn_complete', stopReason: response.stopReason })
      send(running, { type: 'status', status: 'idle' })
      return { ok: true }
    } catch (error) {
      if (error instanceof StallTimeoutError && running.sessionId) {
        await running.context.notify(methods.agent.session.cancel, { sessionId: running.sessionId }).catch(() => {})
        const graceMs = options.stallCancelGraceMs ?? DEFAULT_STALL_CANCEL_GRACE_MS
        if (graceMs > 0) await new Promise((resolve) => setTimeout(resolve, graceMs))
      }
      const failure = promptFailure(error, running.authMethods)
      if (isAuthRequired(error)) running.authRequired = true
      for (const event of failure.events) send(running, event)
      return failure.result
    } finally {
      running.busy = false
      running.wakeGate?.flush()
    }
  }

  return {
    async create(request, owner): Promise<AgentCreateResult> {
      const existing = agents.get(request.id)
      if (existing) return openSession(existing)

      const path = adapterPath(request.provider)
      if (!existsSync(path)) {
        return { ok: false, status: 'error', message: `The ${request.provider} ACP adapter is not installed.` }
      }

      const launch = buildAgentProcessLaunch(process.execPath, path, request.cwd, process.env)
      const child = spawn(launch.executable, launch.args, {
        ...launch.options,
        stdio: ['pipe', 'pipe', 'pipe']
      })
      const pendingApprovals = new Map<string, PendingApproval>()
      let running: RunningAgent
      const app = client({ name: 'ADE ACP prototype' })
        .onNotification(methods.client.session.update, ({ params }) => {
          const update = params.update
          if (
            update.sessionUpdate === 'user_message_chunk' &&
            update.content.type === 'text' &&
            !isInternalNotificationText(update.content.text)
          ) {
            send(running, {
              type: 'message',
              role: 'user',
              messageId: update.messageId ?? 'user-current',
              text: update.content.text
            })
          } else if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
            send(running, {
              type: 'message',
              role: 'assistant',
              messageId: update.messageId ?? 'assistant-current',
              text: update.content.text
            })
          } else if (update.sessionUpdate === 'agent_thought_chunk' && update.content.type === 'text') {
            send(running, {
              type: 'message',
              role: 'thought',
              messageId: update.messageId ?? 'thought-current',
              text: update.content.text
            })
          } else if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
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
              running.cachedModels = modelSelector.models
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
        // The node's identity travels with the agent so work it starts outside ADE's sight -
        // a worktree it creates for itself - can name the node that asked for it.
        environment: { ...process.env, ADE_NODE_ID: request.id },
        cachedModels:
          request.provider === 'codex' && options.codexHome
            ? readCachedCodexModels(options.codexHome, request.modelId)
            : undefined,
        pendingApprovals,
        busy: false,
        stopping: false,
        authRequired: false,
        imageSupport: false,
        steeringSupport: false
      }
      running.wakeGate = createPromptWakeGate<AgentPromptContent>({
        deliver: (content) => runPrompt(request.id, content)
      })
      agents.set(request.id, running)

      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (data: string) => {
        const message = data.trim()
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
            elicitation: { url: {} },
            plan: {},
            // Not ACP's `terminal` capability (which would make us host live terminals for the
            // agent): this `_meta` flag is what both adapters gate their `terminal_output` /
            // `terminal_exit` notifications on. Without it claude-agent-acp folds a Bash result
            // into a fenced code block and reports no exit code at all, and the shell tool card
            // has nothing to show but prose. See `terminalChunkOf` in `shared/agent-activity.ts`.
            _meta: { terminal_output: true }
          },
          clientInfo: { name: 'ade', title: 'ADE', version: '0.1.0' }
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

    async promptWhenIdle(id: string, content: AgentPromptContent): Promise<AgentPromptResult> {
      const running = agents.get(id)
      if (!running?.sessionId) return { ok: false, message: 'The agent session is not ready.' }
      if (!running.wakeGate) return runPrompt(id, content)
      if (!running.busy) return runPrompt(id, content)
      if (running.steeringSupport) {
        return deliverSteeredPrompt(
          (method, params) => running.context.request<SteeringResponse, typeof params>(method, params),
          running.sessionId,
          content
        )
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
        running.cachedModels = { ...running.cachedModels, currentModelId: modelId }
        send(running, { type: 'models', models: running.cachedModels })
        return { ok: true }
      }
      if (!running.modelConfigId) return { ok: false, message: 'This agent does not expose model selection.' }
      try {
        const response = await running.context.request(methods.agent.session.setConfigOption, {
          sessionId: running.sessionId,
          configId: running.modelConfigId,
          value: modelId
        })
        // Setting a model can reshape the agent's other selectors (effort levels, fast mode).
        const modelSelector = modelSelectorFromConfigOptions(response.configOptions)
        if (modelSelector) {
          running.modelConfigId = modelSelector.configId
          running.cachedModels = modelSelector.models
          send(running, { type: 'models', models: modelSelector.models })
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
            const auth = spawn(launch.executable, launch.args, {
              ...launch.options,
              stdio: ['pipe', 'pipe', 'pipe']
            })
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

    resolveApproval(id, approvalId, optionId): void {
      const running = agents.get(id)
      const pending = running?.pendingApprovals.get(approvalId)
      if (!running || !pending) return
      running.pendingApprovals.delete(approvalId)
      pending.resolve({
        outcome: optionId ? { outcome: 'selected', optionId } : { outcome: 'cancelled' }
      })
    },

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

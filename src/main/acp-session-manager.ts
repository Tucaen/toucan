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
  type ClientConnection,
  type ClientContext,
  type CreateElicitationRequest,
  type RequestPermissionResponse,
  type SessionConfigOption
} from '@agentclientprotocol/sdk'
import type {
  AgentAuthMethod,
  AgentCreateRequest,
  AgentCreateResult,
  AgentEvent,
  AgentModeState,
  AgentModelState,
  AgentPermissionOption,
  AgentProvider,
  AgentPromptResult
} from '../shared/agent'
import { activityFromUpdate } from '../shared/agent-activity'
import { modelSelectorFromConfigOptions } from '../shared/agent-models'
import { buildAgentProcessLaunch, type AgentProcessLaunch } from './agent-process'
import { readCachedCodexModels } from './codex-model-cache'
import { createCaptainWakeGate, type CaptainWakeGate } from './firstmate-captain-wake'
import type { FirstMateLaunch } from './firstmate-runtime'

interface PendingApproval {
  resolve(response: RequestPermissionResponse): void
}

interface RunningAgent {
  request: AgentCreateRequest
  owner: WebContents
  process: ChildProcessWithoutNullStreams
  connection: ClientConnection
  context: ClientContext
  adapterPath: string
  authProcess?: (args: string[]) => AgentProcessLaunch
  authMethods: AgentAuthMethod[]
  environment: NodeJS.ProcessEnv
  cachedModels?: AgentModelState
  sessionId?: string
  modelConfigId?: string
  pendingApprovals: Map<string, PendingApproval>
  busy: boolean
  stopping: boolean
  wakeGate?: CaptainWakeGate
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (
    typeof error === 'object'
    && error !== null
    && typeof (error as { message?: unknown }).message === 'string'
  ) return (error as { message: string }).message
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
    typeof data === 'object'
    && data !== null
    && (data as { errorKind?: unknown }).errorKind === 'authentication_failed'
  )
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

function simplifyModes(modes: {
  currentModeId: string
  availableModes: Array<{ id: string; name: string; description?: string | null }>
} | null | undefined): AgentModeState | undefined {
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
  codexHome?: string
  resolveFirstMateLaunch?(provider: AgentProvider, modelId?: string): FirstMateLaunch | null
  configureFirstMateValidator?(provider: AgentProvider, modelId?: string): Promise<AgentPromptResult>
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
  prompt(id: string, text: string): Promise<AgentPromptResult>
  promptWhenIdle(id: string, text: string): Promise<AgentPromptResult>
  setMode(id: string, modeId: string): Promise<AgentPromptResult>
  setModel(id: string, modelId: string): Promise<AgentPromptResult>
  authenticate(id: string, methodId: string): Promise<AgentCreateResult>
  resolveApproval(id: string, approvalId: string, optionId?: string): void
  cancel(id: string): void
  kill(id: string): void
  killOwned(owner: WebContents): void
  killAll(): void
}

export function createAcpSessionManager(options: AcpSessionManagerOptions): AcpSessionManager {
  const agents = new Map<string, RunningAgent>()

  const send = (running: RunningAgent, event: AgentEvent): void => {
    if (!running.owner.isDestroyed()) running.owner.send('agent:event', { id: running.request.id, event })
  }

  const adapterPath = (provider: AgentCreateRequest['provider']): string => join(
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
  ): Promise<AgentModelState> => {
    const modelId = running.request.modelId
    if (
      !running.modelConfigId
      || !modelId
      || modelId === models.currentModelId
      || !models.availableModels.some((model) => model.id === modelId)
    ) return models
    try {
      await running.context.request(methods.agent.session.setConfigOption, {
        sessionId: running.sessionId!,
        configId: running.modelConfigId,
        value: modelId
      })
      return { ...models, currentModelId: modelId }
    } catch (error) {
      send(running, { type: 'error', message: `Could not select the saved model: ${errorMessage(error)}` })
      return models
    }
  }

  const openSession = async (running: RunningAgent): Promise<AgentCreateResult> => {
    send(running, { type: 'status', status: 'starting' })
    try {
      let modes: AgentModeState | undefined
      let models: AgentModelState | undefined
      const configure = (response: {
        modes?: Parameters<typeof simplifyModes>[0]
        configOptions?: SessionConfigOption[] | null
      }): void => {
        modes = simplifyModes(response.modes)
        const selector = modelSelectorFromConfigOptions(response.configOptions)
        running.modelConfigId = selector?.configId
        models = selector?.models
      }
      let resumed = false
      if (running.request.sessionId) {
        try {
          const response = await running.context.request(methods.agent.session.load, {
            sessionId: running.request.sessionId,
            cwd: running.request.cwd,
            mcpServers: []
          })
          running.sessionId = running.request.sessionId
          configure(response)
          resumed = true
        } catch (error) {
          if (running.request.scope !== 'firstmate' || isAuthRequired(error)) throw error
          send(running, {
            type: 'error',
            message: 'The saved FirstMate conversation is unavailable; starting a new one.'
          })
          running.request.sessionId = undefined
          running.sessionId = undefined
        }
      }
      if (!resumed) {
        const response = await running.context.request(methods.agent.session.new, {
          cwd: running.request.cwd,
          mcpServers: []
        })
        running.sessionId = response.sessionId
        configure(response)
      }
      const sessionId = running.sessionId
      if (!sessionId) throw new Error('The agent did not return a session ID.')
      if (
        running.request.permissionMode
        && modes?.availableModes.some((mode) => mode.id === running.request.permissionMode)
        && modes.currentModeId !== running.request.permissionMode
      ) {
        await running.context.request(methods.agent.session.setMode, {
          sessionId,
          modeId: running.request.permissionMode
        })
        modes = { ...modes, currentModeId: running.request.permissionMode }
      }
      if (models) models = await applySavedModel(running, models)
      if (models) running.cachedModels = models
      if (running.request.scope === 'firstmate' && models) {
        const configured = await options.configureFirstMateValidator?.(
          running.request.provider,
          models.currentModelId
        )
        if (configured && !configured.ok) {
          send(running, {
            type: 'error',
            message: configured.message ?? 'Could not configure the FirstMate validation runtime.'
          })
        }
      }
      send(running, { type: 'session', sessionId })
      if (modes) send(running, { type: 'modes', modes })
      if (models) send(running, { type: 'models', models })
      send(running, { type: 'status', status: 'ready' })
      return {
        ok: true,
        status: 'ready',
        sessionId,
        ...(modes ? { modes } : {}),
        ...(models ? { models } : {})
      }
    } catch (error) {
      if (isAuthRequired(error)) {
        const models = running.cachedModels
        send(running, { type: 'auth', methods: running.authMethods })
        if (models) send(running, { type: 'models', models })
        send(running, { type: 'status', status: 'auth_required' })
        return {
          ok: false,
          status: 'auth_required',
          authMethods: running.authMethods,
          ...(models ? { models } : {})
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
    running.connection.close()
    running.process.kill()
    agents.delete(id)
  }

  const runPrompt = async (id: string, text: string): Promise<AgentPromptResult> => {
    const running = agents.get(id)
    if (!running?.sessionId) return { ok: false, message: 'The agent session is not ready.' }
    if (running.busy) return { ok: false, message: 'The agent session is busy.' }
    running.busy = true
    send(running, { type: 'status', status: 'working' })
    try {
      const response = await running.context.request(methods.agent.session.prompt, {
        sessionId: running.sessionId,
        prompt: [{ type: 'text', text }]
      })
      send(running, { type: 'turn_complete', stopReason: response.stopReason })
      send(running, { type: 'status', status: 'idle' })
      return { ok: true }
    } catch (error) {
      const failure = promptFailure(error, running.authMethods)
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

      const firstMateLaunch = request.scope === 'firstmate'
        ? options.resolveFirstMateLaunch?.(request.provider, request.modelId) ?? null
        : null
      if (request.scope === 'firstmate' && !firstMateLaunch) {
        return { ok: false, status: 'error', message: 'FirstMate is not installed.' }
      }
      const effectiveRequest: AgentCreateRequest = firstMateLaunch
        ? { ...request, cwd: firstMateLaunch.cwd }
        : request
      const environment = firstMateLaunch?.environment ?? process.env

      const path = adapterPath(effectiveRequest.provider)
      if (!firstMateLaunch?.agentProcess && !existsSync(path)) {
        return { ok: false, status: 'error', message: `The ${effectiveRequest.provider} ACP adapter is not installed.` }
      }

      const launch = firstMateLaunch?.agentProcess
        ?? buildAgentProcessLaunch(process.execPath, path, effectiveRequest.cwd, environment)
      const child = spawn(launch.executable, launch.args, {
        ...launch.options,
        stdio: ['pipe', 'pipe', 'pipe']
      })
      const pendingApprovals = new Map<string, PendingApproval>()
      let running: RunningAgent
      const app = client({ name: 'ADE ACP prototype' })
        .onNotification(methods.client.session.update, ({ params }) => {
          const update = params.update
          if (update.sessionUpdate === 'user_message_chunk' && update.content.type === 'text') {
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
            const selector = modelSelectorFromConfigOptions(update.configOptions)
            if (selector) {
              running.modelConfigId = selector.configId
              send(running, { type: 'models', models: selector.models })
            }
          } else if (update.sessionUpdate === 'usage_update') {
            send(running, {
              type: 'usage',
              used: update.used,
              size: update.size,
              ...(update.cost ? { cost: `${update.cost.amount} ${update.cost.currency}` } : {})
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
            title: params.toolCall.title ?? 'Permission requested',
            options
          })
          return new Promise((resolve) => pendingApprovals.set(approvalId, { resolve }))
        })
        .onRequest(methods.client.elicitation.create, async ({ params }) => {
          const elicitation = params as CreateElicitationRequest
          if (elicitation.mode === 'url' && 'url' in elicitation && typeof elicitation.url === 'string') {
            await shell.openExternal(elicitation.url)
            send(running, { type: 'status', status: 'starting', message: elicitation.message })
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
        request: effectiveRequest,
        owner,
        process: child,
        connection,
        context: connection.agent,
        adapterPath: path,
        authProcess: firstMateLaunch?.authProcess,
        authMethods: [],
        environment,
        cachedModels: effectiveRequest.provider === 'codex' && options.codexHome
          ? readCachedCodexModels(options.codexHome, effectiveRequest.modelId)
          : undefined,
        pendingApprovals,
        busy: false,
        stopping: false
      }
      running.wakeGate = createCaptainWakeGate({
        deliver: (text) => runPrompt(request.id, text),
        onExpired: () => {
          send(running, {
            type: 'error',
            message: 'A queued message expired because the agent did not become idle in time.'
          })
        }
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
          send(running, { type: 'status', status: 'exited', message: `ACP adapter exited with code ${code ?? 'unknown'}.` })
        }
      })

      try {
        const initialized = await running.context.request(methods.agent.initialize, {
          protocolVersion: 1,
          clientCapabilities: {
            auth: { terminal: true },
            elicitation: { url: {} },
            plan: {}
          },
          clientInfo: { name: 'ade', title: 'ADE', version: '0.1.0' }
        })
        running.authMethods = (initialized.authMethods ?? []).map(simplifyAuthMethod)
        return await openSession(running)
      } catch (error) {
        const message = errorMessage(error)
        send(running, { type: 'error', message })
        stop(request.id)
        return { ok: false, status: 'error', message }
      }
    },

    prompt: runPrompt,

    async promptWhenIdle(id: string, text: string): Promise<AgentPromptResult> {
      const running = agents.get(id)
      if (!running?.sessionId) return { ok: false, message: 'The agent session is not ready.' }
      if (!running.wakeGate) return runPrompt(id, text)
      if (!running.busy) return runPrompt(id, text)
      return running.wakeGate.enqueue(text)
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
        const selector = modelSelectorFromConfigOptions(response.configOptions)
        if (selector) send(running, { type: 'models', models: selector.models })
        running.request.modelId = modelId
        if (running.request.scope === 'firstmate') {
          const configured = await options.configureFirstMateValidator?.(running.request.provider, modelId)
          if (configured && !configured.ok) {
            const message = configured.message ?? 'Could not configure the FirstMate validation runtime.'
            send(running, { type: 'error', message })
            return { ok: false, message }
          }
        }
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
      send(running, { type: 'status', status: 'starting', message: `Signing in with ${method.name}...` })
      try {
        if (method.type === 'terminal') {
          await new Promise<void>((resolve, reject) => {
            const launch = running.authProcess?.(method.args ?? []) ?? buildAgentProcessLaunch(
              process.execPath,
              running.adapterPath,
              running.request.cwd,
              running.environment,
              method.args
            )
            const auth = spawn(launch.executable, launch.args, {
              ...launch.options,
              stdio: ['ignore', 'pipe', 'pipe']
            })
            auth.stdout.setEncoding('utf8')
            auth.stderr.setEncoding('utf8')
            const report = (data: string): void => {
              const message = data.trim()
              if (message) send(running, { type: 'status', status: 'starting', message })
            }
            auth.stdout.on('data', report)
            auth.stderr.on('data', report)
            auth.once('error', reject)
            auth.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`Login exited with code ${code}.`)))
          })
        } else {
          await running.context.request(methods.agent.authenticate, { methodId })
        }
        return await openSession(running)
      } catch (error) {
        const message = errorMessage(error)
        send(running, { type: 'error', message })
        return { ok: false, status: 'error', message }
      }
    },

    resolveApproval(id, approvalId, optionId): void {
      const running = agents.get(id)
      const pending = running?.pendingApprovals.get(approvalId)
      if (!running || !pending) return
      running.pendingApprovals.delete(approvalId)
      pending.resolve({
        outcome: optionId
          ? { outcome: 'selected', optionId }
          : { outcome: 'cancelled' }
      })
    },

    cancel(id): void {
      const running = agents.get(id)
      if (!running?.sessionId) return
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

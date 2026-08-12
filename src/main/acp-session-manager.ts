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
  type SessionUpdate,
  type ToolCallContent
} from '@agentclientprotocol/sdk'
import type {
  AgentActivity,
  AgentAuthMethod,
  AgentCreateRequest,
  AgentCreateResult,
  AgentEvent,
  AgentPermissionOption,
  AgentPromptResult
} from '../shared/agent'

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
  authMethods: AgentAuthMethod[]
  sessionId?: string
  pendingApprovals: Map<string, PendingApproval>
  stopping: boolean
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isAuthRequired(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === -32000
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

function toolContentText(content: ToolCallContent[] | null | undefined): string | undefined {
  if (!content?.length) return undefined
  const lines = content.flatMap((item) => {
    if (item.type === 'content' && item.content.type === 'text') return [item.content.text]
    if (item.type === 'diff') return [`Changed ${item.path}`]
    if (item.type === 'terminal') return ['Terminal output is available.']
    return []
  })
  return lines.length > 0 ? lines.join('\n') : undefined
}

function activityFromUpdate(update: Extract<SessionUpdate, { sessionUpdate: 'tool_call' | 'tool_call_update' }>): AgentActivity {
  return {
    id: update.toolCallId,
    title: update.title ?? 'Agent activity',
    ...(update.kind ? { kind: update.kind } : {}),
    ...(update.status ? { status: update.status } : {}),
    ...(toolContentText(update.content) ? { content: toolContentText(update.content) } : {}),
    ...(update.locations ? { locations: update.locations.map((location) => location.path) } : {})
  }
}

export interface AcpSessionManagerOptions {
  appPath: string
}

export interface AcpSessionManager {
  create(request: AgentCreateRequest, owner: WebContents): Promise<AgentCreateResult>
  prompt(id: string, text: string): Promise<AgentPromptResult>
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

  const openSession = async (running: RunningAgent): Promise<AgentCreateResult> => {
    send(running, { type: 'status', status: 'starting' })
    try {
      if (running.request.sessionId) {
        await running.context.request(methods.agent.session.load, {
          sessionId: running.request.sessionId,
          cwd: running.request.cwd,
          mcpServers: []
        })
        running.sessionId = running.request.sessionId
      } else {
        const response = await running.context.request(methods.agent.session.new, {
          cwd: running.request.cwd,
          mcpServers: []
        })
        running.sessionId = response.sessionId
      }
      send(running, { type: 'session', sessionId: running.sessionId })
      send(running, { type: 'status', status: 'ready' })
      return { ok: true, status: 'ready', sessionId: running.sessionId }
    } catch (error) {
      if (isAuthRequired(error)) {
        send(running, { type: 'auth', methods: running.authMethods })
        send(running, { type: 'status', status: 'auth_required' })
        return { ok: false, status: 'auth_required', authMethods: running.authMethods }
      }
      const message = errorMessage(error)
      send(running, { type: 'error', message })
      return { ok: false, status: 'error', message }
    }
  }

  const stop = (id: string): void => {
    const running = agents.get(id)
    if (!running) return
    running.stopping = true
    for (const pending of running.pendingApprovals.values()) {
      pending.resolve({ outcome: { outcome: 'cancelled' } })
    }
    running.pendingApprovals.clear()
    running.connection.close()
    running.process.kill()
    agents.delete(id)
  }

  return {
    async create(request, owner): Promise<AgentCreateResult> {
      const existing = agents.get(request.id)
      if (existing) return openSession(existing)

      const path = adapterPath(request.provider)
      if (!existsSync(path)) {
        return { ok: false, status: 'error', message: `The ${request.provider} ACP adapter is not installed.` }
      }

      const child = spawn(process.execPath, [path], {
        cwd: request.cwd,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
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
        request,
        owner,
        process: child,
        connection,
        context: connection.agent,
        adapterPath: path,
        authMethods: [],
        pendingApprovals,
        stopping: false
      }
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

    async prompt(id, text): Promise<AgentPromptResult> {
      const running = agents.get(id)
      if (!running?.sessionId) return { ok: false, message: 'The agent session is not ready.' }
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
        const message = errorMessage(error)
        send(running, { type: 'error', message })
        send(running, { type: 'status', status: 'idle' })
        return { ok: false, message }
      }
    },

    async authenticate(id, methodId): Promise<AgentCreateResult> {
      const running = agents.get(id)
      if (!running) return { ok: false, status: 'error', message: 'The agent session is not running.' }
      const method = running.authMethods.find((candidate) => candidate.id === methodId)
      if (!method) return { ok: false, status: 'error', message: 'That authentication method is unavailable.' }
      send(running, { type: 'status', status: 'starting', message: `Signing in with ${method.name}â€¦` })
      try {
        if (method.type === 'terminal') {
          await new Promise<void>((resolve, reject) => {
            const auth = spawn(process.execPath, [running.adapterPath, ...(method.args ?? [])], {
              cwd: running.request.cwd,
              env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
              stdio: ['ignore', 'pipe', 'pipe'],
              windowsHide: true
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

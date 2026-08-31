import { randomUUID } from 'node:crypto'
import { normalize, win32 } from 'node:path'
import type {
  AgentCreateRequest,
  AgentCreateResult,
  AgentEvent,
  AgentPromptContent,
  AgentPromptResult
} from '../shared/agent'
import type {
  BrainDumpCaptureConversation,
  BrainDumpCaptureFailureCode,
  BrainDumpCaptureRequest,
  BrainDumpCaptureStartResult,
  BrainDumpCaptureState
} from '../shared/brain-dump'

export interface BrainDumpCaptureOwner {
  isDestroyed(): boolean
  send(channel: string, ...args: unknown[]): void
}

export interface BrainDumpCaptureAgent {
  create(request: AgentCreateRequest, owner: BrainDumpCaptureOwner): Promise<AgentCreateResult>
  prompt(id: string, content: AgentPromptContent): Promise<AgentPromptResult>
  cancel(id: string): void
  kill?(id: string): void
}

export interface BrainDumpCaptureManager {
  start(request: BrainDumpCaptureRequest, owner?: BrainDumpCaptureOwner): Promise<BrainDumpCaptureStartResult>
  current(): BrainDumpCaptureState | null
  cancel(jobId: string): void
  disconnectOwner(owner: BrainDumpCaptureOwner): void
  shutdown(): void
}

export interface BrainDumpCaptureManagerOptions {
  agent: BrainDumpCaptureAgent
  homeDirectory: string
  registeredProjectPaths(): readonly string[] | Promise<readonly string[]>
  createJobId?: () => string
  publish?: (state: BrainDumpCaptureState) => void
  initialState?: BrainDumpCaptureState | null
}

function pathIdentity(path: string): string {
  const normalized = win32.isAbsolute(path) ? win32.normalize(path) : normalize(path)
  return normalized
    .replace(/[\\/]+$/, '')
    .replace(/\\/g, '/')
    .toLocaleLowerCase('en-US')
}

export function buildBrainDumpCapturePrompt(content: string, projectPath?: string): AgentPromptContent {
  const association = projectPath ?? 'unassigned'
  return [
    {
      type: 'text',
      text: `Use the brain-dump skill to file the reviewed content. The explicit project association is ${association}. Preserve an existing topic association unless the content explicitly changes it.`
    },
    { type: 'text', text: content }
  ]
}

function failureCode(message: string): BrainDumpCaptureFailureCode {
  return /stall|timed? out|timeout/i.test(message) ? 'timeout' : 'skill'
}

export function createBrainDumpCaptureManager(options: BrainDumpCaptureManagerOptions): BrainDumpCaptureManager {
  let state = options.initialState ?? null
  if (state?.status === 'working') {
    state = {
      status: 'failed',
      jobId: state.jobId,
      code: 'unverifiable',
      message: 'Capture state is unverifiable after restart.'
    }
  }
  let activeId: string | null = null
  let starting = false
  let conversation: BrainDumpCaptureConversation | undefined
  let summary = ''
  const assistantMessages = new Map<string, string>()
  const owners = new Set<BrainDumpCaptureOwner>()

  const setState = (next: BrainDumpCaptureState): void => {
    state = next
    options.publish?.(next)
    for (const owner of owners) if (!owner.isDestroyed()) owner.send('brain-dump:capture-event', next)
  }

  const agentOwner: BrainDumpCaptureOwner = {
    isDestroyed: () => false,
    send: (channel, value) => {
      const envelope = value as { id?: string; event?: AgentEvent }
      if (channel !== 'agent:event' || envelope.id !== activeId || !envelope.event) return
      const event = envelope.event as AgentEvent
      if (event.type === 'session' && conversation) conversation = { ...conversation, conversationId: event.sessionId }
      if (event.type === 'message' && event.role === 'assistant' && event.presentation !== 'progress') {
        const text = `${assistantMessages.get(event.messageId) ?? ''}${event.text}`
        assistantMessages.set(event.messageId, text)
        summary = text.trim()
      }
    }
  }

  async function start(
    request: BrainDumpCaptureRequest,
    owner?: BrainDumpCaptureOwner
  ): Promise<BrainDumpCaptureStartResult> {
    if (typeof request?.content !== 'string' || !request.content.trim())
      return { ok: false, code: 'invalid-content', message: 'Reviewed content is required.' }
    if (request.provider !== 'claude' && request.provider !== 'codex')
      return { ok: false, code: 'invalid-provider', message: 'Provider is invalid.' }
    if (starting || state?.status === 'working')
      return { ok: false, code: 'busy', message: 'A brain-dump capture is already running.' }

    starting = true
    let projects: readonly string[]
    try {
      projects = await options.registeredProjectPaths()
    } catch (error) {
      starting = false
      return {
        ok: false,
        code: 'invalid-project',
        message: error instanceof Error ? error.message : 'Registered projects could not be read.'
      }
    }
    let cwd = options.homeDirectory
    if (request.projectPath !== undefined) {
      const registered = projects.find((path) => pathIdentity(path) === pathIdentity(request.projectPath!))
      if (!registered) {
        starting = false
        return { ok: false, code: 'invalid-project', message: 'Project is not registered in the workspace.' }
      }
      cwd = registered
    }
    if (owner) owners.add(owner)
    const jobId = options.createJobId?.() ?? randomUUID()
    activeId = jobId
    conversation = undefined
    summary = ''
    assistantMessages.clear()
    const working: BrainDumpCaptureState = { status: 'working', jobId }
    setState(working)
    starting = false
    let created: AgentCreateResult
    try {
      created = await options.agent.create({ id: jobId, provider: request.provider, cwd }, agentOwner)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setState({ status: 'failed', jobId, code: 'startup', message })
      activeId = null
      return { ok: true, state: state! }
    }
    if (!created.ok || created.status !== 'ready' || !created.sessionId) {
      conversation = created.sessionId
        ? { provider: request.provider, conversationId: created.sessionId, cwd }
        : undefined
      setState({
        status: 'failed',
        jobId,
        code: created.status === 'auth_required' ? 'auth' : 'startup',
        message:
          created.message ??
          (created.status === 'auth_required' ? 'Authentication is required.' : 'Provider startup failed.'),
        ...(conversation ? { conversation } : {})
      })
      activeId = null
      return { ok: true, state: state! }
    }
    conversation = { provider: request.provider, conversationId: created.sessionId, cwd }
    void options.agent
      .prompt(jobId, buildBrainDumpCapturePrompt(request.content, request.projectPath ? cwd : undefined))
      .then(
        (result) => {
          if (activeId !== jobId || state?.status !== 'working') return
          if (result.ok) {
            setState({
              status: 'completed',
              jobId,
              summary: summary || 'Brain-dump capture completed.',
              conversation: conversation!
            })
          } else {
            const message = result.message ?? 'Brain-dump skill failed.'
            setState({ status: 'failed', jobId, code: failureCode(message), message, conversation })
          }
          activeId = null
        },
        (error: unknown) => {
          if (activeId !== jobId || state?.status !== 'working') return
          const message = error instanceof Error ? error.message : String(error)
          setState({ status: 'failed', jobId, code: failureCode(message), message, conversation })
          activeId = null
        }
      )
    return { ok: true, state: working }
  }

  return {
    start,
    current: () => state,
    cancel(jobId) {
      if (activeId !== jobId || state?.status !== 'working') return
      options.agent.cancel(jobId)
      setState({
        status: 'failed',
        jobId,
        code: 'cancelled',
        message: 'Capture was cancelled.',
        ...(conversation ? { conversation } : {})
      })
      activeId = null
    },
    disconnectOwner: (owner) => void owners.delete(owner),
    shutdown() {
      if (activeId) options.agent.kill?.(activeId)
    }
  }
}

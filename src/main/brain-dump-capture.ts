import { randomUUID } from 'node:crypto'
import { normalize, win32 } from 'node:path'
import type {
  AgentCreateRequest,
  AgentCreateResult,
  AgentEvent,
  AgentPromptContent,
  AgentPromptResult
} from '../shared/agent'
import { AGENT_CHANNELS, BRAIN_DUMP_CHANNELS } from '../shared/ipc-channels'
import { pathIdentity } from '../shared/paths'
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
  resolveApproval(id: string, approvalId: string, optionId?: string): void
  cancel(id: string): void
  kill?(id: string): void
}

export interface BrainDumpCaptureManager {
  start(request: BrainDumpCaptureRequest, owner?: BrainDumpCaptureOwner): Promise<BrainDumpCaptureStartResult>
  current(): BrainDumpCaptureState | null
  resolveApproval(jobId: string, approvalId: string, optionId?: string): void
  cancel(jobId: string): void
  disconnectOwner(owner: BrainDumpCaptureOwner): void
  shutdown(): void
}

export interface BrainDumpCaptureManagerOptions {
  agent: BrainDumpCaptureAgent
  homeDirectory: string
  /**
   * The brain-dump library root. Declared as an additional directory of the capture session, so
   * the skill can write topic files there directly: without it, Codex's workspace-write sandbox
   * escalates every write outside `cwd` into a permission request, and the capture crawls or stalls.
   */
  libraryDirectory?: string
  registeredProjectPaths(): readonly string[] | Promise<readonly string[]>
  createJobId?: () => string
  /** Debounces streamed final-answer chunks before treating the capture as complete. */
  finalAnswerGraceMs?: number
  publish?: (state: BrainDumpCaptureState) => void
  initialState?: BrainDumpCaptureState | null
}

export const DEFAULT_FINAL_ANSWER_GRACE_MS = 500

/**
 * `pathIdentity` plus the one thing pure string work cannot do: resolve `.` and `..` segments. A
 * capture's project association arrives as whatever the request carried, so `D:\a\..\b` has to
 * match the registered `D:\b`. Kept as a layer over the shared rule rather than as a second rule -
 * `node:path` is exactly what `src/shared` may not import, and that is the whole of the difference.
 */
function resolvedPathIdentity(path: string): string {
  return pathIdentity(win32.isAbsolute(path) ? win32.normalize(path) : normalize(path))
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
  let finalAnswerTimer: ReturnType<typeof setTimeout> | undefined
  const assistantMessages = new Map<string, string>()
  const owners = new Set<BrainDumpCaptureOwner>()

  const setState = (next: BrainDumpCaptureState): void => {
    state = next
    options.publish?.(next)
    for (const owner of owners) if (!owner.isDestroyed()) owner.send(BRAIN_DUMP_CHANNELS.captureEvent, next)
  }

  const clearFinalAnswerTimer = (): void => {
    if (finalAnswerTimer !== undefined) clearTimeout(finalAnswerTimer)
    finalAnswerTimer = undefined
  }

  const completeAfterFinalAnswer = (jobId: string): void => {
    clearFinalAnswerTimer()
    finalAnswerTimer = setTimeout(() => {
      finalAnswerTimer = undefined
      if (activeId !== jobId || state?.status !== 'working' || !conversation || !summary) return
      setState({ status: 'completed', jobId, summary, conversation })
      activeId = null
      // The provider has delivered its final answer, but an adapter can still leave the ACP
      // request pending. Cancel that completed turn so its stall guard cannot report a false
      // timeout later; the resumable session itself remains available.
      options.agent.cancel(jobId)
    }, options.finalAnswerGraceMs ?? DEFAULT_FINAL_ANSWER_GRACE_MS)
  }

  const agentOwner: BrainDumpCaptureOwner = {
    isDestroyed: () => false,
    send: (channel, value) => {
      const envelope = value as { id?: string; event?: AgentEvent }
      if (channel !== AGENT_CHANNELS.event || envelope.id !== activeId || !envelope.event) return
      const event = envelope.event as AgentEvent
      if (event.type === 'session' && conversation) conversation = { ...conversation, conversationId: event.sessionId }
      if (event.type === 'approval' && state?.status === 'working') {
        setState({
          status: 'working',
          jobId: envelope.id!,
          approval: {
            id: event.approvalId,
            title: event.title,
            options: event.options,
            ...(event.activity ? { activity: event.activity } : {})
          }
        })
      }
      if (event.type === 'message' && event.role === 'assistant' && event.presentation !== 'progress') {
        const text = `${assistantMessages.get(event.messageId) ?? ''}${event.text}`
        assistantMessages.set(event.messageId, text)
        summary = text.trim()
        if (event.presentation === 'final') completeAfterFinalAnswer(envelope.id!)
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
      const registered = projects.find(
        (path) => resolvedPathIdentity(path) === resolvedPathIdentity(request.projectPath!)
      )
      if (!registered) {
        starting = false
        return { ok: false, code: 'invalid-project', message: 'Project is not registered in the workspace.' }
      }
      cwd = registered
    }
    if (owner) owners.add(owner)
    const jobId = options.createJobId?.() ?? randomUUID()
    activeId = jobId
    clearFinalAnswerTimer()
    conversation = undefined
    summary = ''
    assistantMessages.clear()
    const working: BrainDumpCaptureState = { status: 'working', jobId }
    setState(working)
    starting = false
    let created: AgentCreateResult
    try {
      created = await options.agent.create(
        {
          id: jobId,
          provider: request.provider,
          cwd,
          ...(options.libraryDirectory ? { additionalDirectories: [options.libraryDirectory] } : {})
        },
        agentOwner
      )
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
          clearFinalAnswerTimer()
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
          clearFinalAnswerTimer()
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
    resolveApproval(jobId, approvalId, optionId) {
      if (
        activeId !== jobId ||
        state?.status !== 'working' ||
        state.approval?.id !== approvalId ||
        (optionId !== undefined && !state.approval.options.some((option) => option.id === optionId))
      )
        return
      options.agent.resolveApproval(jobId, approvalId, optionId)
      setState({ status: 'working', jobId })
    },
    cancel(jobId) {
      if (activeId !== jobId || state?.status !== 'working') return
      clearFinalAnswerTimer()
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
      clearFinalAnswerTimer()
      if (activeId) options.agent.kill?.(activeId)
    }
  }
}

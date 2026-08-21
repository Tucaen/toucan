import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import type {
  AgentActivity,
  AgentAuthMethod,
  AgentEvent,
  AgentModeState,
  AgentModelState,
  AgentPermissionOption,
  AgentPlanEntry,
  AgentProvider,
  AgentPromptContent
} from '../../shared/agent'
import { chooseAgentPromptApi, createDispatchOrderGate, deliverAgentPrompt } from './agent-prompt-delivery'
import { readImageAsBase64, type AgentImageAttachment } from './image-attachment'

export type { AgentImageAttachment } from './image-attachment'

export interface AgentChatMessage {
  id: string
  role: 'user' | 'assistant' | 'thought'
  text: string
  /** True until the agent actually starts processing this message (only possible for messages sent while busy). */
  queued?: boolean
  /** True if delivery genuinely failed or expired (e.g. a queued send timed out in the wake gate) - never set alongside `queued`. */
  failed?: boolean
}

export interface AgentApprovalState {
  id: string
  title: string
  options: AgentPermissionOption[]
}

/** The conversation's live context-window usage, as last reported by a `usage_update` session event. */
export interface AgentUsage {
  used?: number
  size?: number
  cost?: string
}

export type AgentChatStatus = 'starting' | 'ready' | 'working' | 'auth_required' | 'exited'

/**
 * The ACP echo that clears a queued badge is normally near-instant (a local notification, not a
 * network round trip). If it never arrives at all - or arrives with text that doesn't exactly
 * match what was sent - a purely echo-driven clear leaves that entry (and, with a naive
 * head-of-FIFO match, every entry behind it) queued forever even though the agent has long since
 * moved on. This bounds that wait so a missed echo degrades to "cleared a bit late" instead of
 * "stuck forever".
 */
const DEFAULT_ECHO_TIMEOUT_MS = 10_000

export interface AgentConversationOptions {
  id: string
  provider: AgentProvider
  cwd: string
  scope?: 'project' | 'firstmate'
  sessionId?: string
  permissionMode?: string
  modelId?: string
  restartKey?: number
  /**
   * Builds what the agent receives from the captain's text. Called at submission, never earlier, so it
   * may resolve request-time facts such as FirstMate's durable project catalog registrations.
   */
  composePrompt?(text: string): string | Promise<string>
  enabled: boolean
  onSessionId(sessionId: string): void
  onPermissionMode(modeId: string): void
  onModel(modelId: string): void
  /**
   * How long a sent message waits in `pendingSentRef` for its own echoed `message`/`role: 'user'`
   * event before its queued badge is force-cleared anyway. Defaults to `DEFAULT_ECHO_TIMEOUT_MS`;
   * overridable so tests can reproduce a missed echo without a real multi-second wait.
   */
  pendingEchoTimeoutMs?: number
}

export interface AgentConversationController {
  messages: AgentChatMessage[]
  activities: AgentActivity[]
  plan: AgentPlanEntry[]
  approval: AgentApprovalState | null
  authMethods: AgentAuthMethod[]
  /**
   * A sign-in URL surfaced during an in-progress reauth attempt (terminal-login stdout or an
   * elicitation request), kept separate from `detail` so it stays visible/actionable and isn't
   * overwritten by the next unrelated status message.
   */
  authLink: string | null
  /** True for the whole span of an in-progress `authenticate()` call, even while `status` is transiently `'starting'`. */
  reauthenticating: boolean
  modes: AgentModeState | null
  models: AgentModelState | null
  status: AgentChatStatus
  usage: AgentUsage | null
  detail?: string
  draft: string
  /** Whether the running agent's ACP handshake advertised support for image content blocks. */
  imageSupport: boolean
  /** Pasted images attached to the draft, shown as removable previews until the message is sent. */
  attachments: AgentImageAttachment[]
  selectorsDisabled: boolean
  setDraft(value: string): void
  addImages(files: File[] | FileList): Promise<void>
  removeAttachment(id: string): void
  submit(event: FormEvent): void
  /** Sends `text` as if the captain had typed and submitted it, bypassing the draft/attachments state entirely. */
  sendMessage(text: string): void
  cancel(): void
  authenticate(methodId: string): void
  openAuthLink(url: string): void
  resolveApproval(approvalId: string, optionId?: string): void
  selectMode(modeId: string): Promise<boolean>
  selectModel(modelId: string): void
}

export function useAgentConversation(options: AgentConversationOptions): AgentConversationController {
  const [messages, setMessages] = useState<AgentChatMessage[]>([])
  const [activitiesById, setActivitiesById] = useState<Record<string, AgentActivity>>({})
  const [plan, setPlan] = useState<AgentPlanEntry[]>([])
  const [approval, setApproval] = useState<AgentApprovalState | null>(null)
  const [authMethods, setAuthMethods] = useState<AgentAuthMethod[]>([])
  const [authLink, setAuthLink] = useState<string | null>(null)
  const [reauthenticating, setReauthenticating] = useState(false)
  const [modes, setModes] = useState<AgentModeState | null>(null)
  const [models, setModels] = useState<AgentModelState | null>(null)
  const [status, setStatus] = useState<AgentChatStatus>('starting')
  const [usage, setUsage] = useState<AgentUsage | null>(null)
  const [detail, setDetail] = useState<string>()
  const [draft, setDraft] = useState('')
  const [imageSupport, setImageSupport] = useState(false)
  const [attachments, setAttachments] = useState<AgentImageAttachment[]>([])
  /**
   * Messages sent but not yet echoed back, so each queued send (not just the latest) clears its
   * own queued flag. Matched by text against an incoming echo (order doesn't matter: an
   * out-of-order or skipped echo must not block a later entry's own echo from matching), with
   * `timer` as the fallback that force-clears this entry if no echo ever arrives. `timer` is only
   * armed once the underlying deliver call (`prompt`/`promptWhenIdle`) has actually settled -
   * a queued send's deliver call doesn't resolve until the wake gate genuinely dispatches it, so
   * arming the timer any earlier would fire it while the message is still legitimately waiting
   * behind another turn, clearing its badge before its real echo arrives and duplicating it.
   */
  const pendingSentRef = useRef<Array<{ id: string; text: string; timer?: ReturnType<typeof setTimeout> }>>([])
  const clearPendingSent = (id: string): void => {
    const index = pendingSentRef.current.findIndex((entry) => entry.id === id)
    if (index < 0) return
    clearTimeout(pendingSentRef.current[index].timer)
    pendingSentRef.current.splice(index, 1)
    setMessages((current) => current.map((message) => (
      message.id === id ? { ...message, queued: false } : message
    )))
  }
  /**
   * Marks a message's delivery as genuinely failed (send rejected, or a queued send expired in
   * the wake gate before ever reaching the agent) - distinct from `clearPendingSent`'s
   * success-shaped clear, so a dropped message can never render identically to a delivered one.
   */
  const markSendFailed = (id: string): void => {
    const index = pendingSentRef.current.findIndex((entry) => entry.id === id)
    if (index >= 0) {
      clearTimeout(pendingSentRef.current[index].timer)
      pendingSentRef.current.splice(index, 1)
    }
    setMessages((current) => current.map((message) => (
      message.id === id ? { ...message, queued: false, failed: true } : message
    )))
  }
  /**
   * Serializes the actual cross-process deliver call in submission order, even when an earlier
   * submit's (async) composePrompt resolves after a later one's.
   */
  const dispatchGateRef = useRef(createDispatchOrderGate())
  const activities = useMemo(() => Object.values(activitiesById), [activitiesById])
  const onSessionId = useRef(options.onSessionId)
  const onPermissionMode = useRef(options.onPermissionMode)
  const onModel = useRef(options.onModel)

  useEffect(() => { onSessionId.current = options.onSessionId }, [options.onSessionId])
  useEffect(() => { onPermissionMode.current = options.onPermissionMode }, [options.onPermissionMode])
  useEffect(() => { onModel.current = options.onModel }, [options.onModel])

  useEffect(() => {
    if (!options.enabled) return
    let active = true
    setMessages([])
    setActivitiesById({})
    setPlan([])
    setApproval(null)
    setAuthMethods([])
    setAuthLink(null)
    setReauthenticating(false)
    setModes(null)
    setModels(null)
    setStatus('starting')
    setUsage(null)
    setDetail(undefined)
    setImageSupport(false)
    setAttachments([])
    const removeListener = window.agentApi.onEvent(options.id, (event: AgentEvent) => {
      if (!active) return
      if (event.type === 'status') {
        setStatus(event.status === 'idle' ? 'ready' : event.status)
        setDetail(event.message)
      } else if (event.type === 'session') {
        onSessionId.current(event.sessionId)
      } else if (event.type === 'message') {
        if (event.role === 'user') {
          const sent = pendingSentRef.current.find((entry) => entry.text === event.text)
          if (sent) {
            clearPendingSent(sent.id)
            return
          }
        }
        setMessages((current) => {
          const existing = current.findIndex((message) => message.id === event.messageId && message.role === event.role)
          if (existing < 0) return [...current, { id: event.messageId, role: event.role, text: event.text }]
          return current.map((message, index) => index === existing ? { ...message, text: message.text + event.text } : message)
        })
      } else if (event.type === 'activity') {
        setActivitiesById((current) => ({
          ...current,
          [event.activity.id]: { ...current[event.activity.id], ...event.activity }
        }))
      } else if (event.type === 'plan') {
        setPlan(event.entries)
      } else if (event.type === 'modes') {
        setModes((current) => event.modes.availableModes.length > 0
          ? event.modes
          : { ...event.modes, availableModes: current?.availableModes ?? [] })
      } else if (event.type === 'models') {
        setModels(event.models)
      } else if (event.type === 'approval') {
        setApproval({ id: event.approvalId, title: event.title, options: event.options })
      } else if (event.type === 'auth') {
        setAuthMethods(event.methods)
        // A fresh auth-required cycle invalidates any sign-in link surfaced by a previous one.
        setAuthLink(null)
      } else if (event.type === 'auth_link') {
        setAuthLink(event.url)
      } else if (event.type === 'usage') {
        setUsage({ used: event.used, size: event.size, cost: event.cost })
      } else if (event.type === 'error') {
        setDetail(event.message)
      }
    })
    void window.agentApi.create({
      id: options.id,
      provider: options.provider,
      cwd: options.cwd,
      scope: options.scope,
      sessionId: options.sessionId,
      permissionMode: options.permissionMode,
      modelId: options.modelId
    }).then((result) => {
      if (!active) return
      if (result.sessionId) onSessionId.current(result.sessionId)
      if (result.authMethods) setAuthMethods(result.authMethods)
      if (result.modes) setModes(result.modes)
      if (result.models) setModels(result.models)
      setImageSupport(result.imageSupport ?? false)
      if (result.status === 'ready') {
        setStatus('ready')
      } else if (result.status === 'auth_required') {
        setStatus('auth_required')
      } else {
        setStatus('exited')
        setDetail(result.message)
      }
    })
    return () => {
      active = false
      removeListener()
      window.agentApi.kill(options.id)
      for (const entry of pendingSentRef.current) clearTimeout(entry.timer)
      pendingSentRef.current = []
    }
  }, [options.cwd, options.enabled, options.id, options.provider, options.restartKey, options.scope])

  /** Shared by `submit` (draft + attachments) and `sendMessage` (a plain string, e.g. a clicked decision option). */
  const dispatchText = (text: string, images: AgentImageAttachment[], onSent: () => void): void => {
    if ((!text && images.length === 0) || (status !== 'ready' && status !== 'working')) return
    const queued = status === 'working'
    const compose = options.composePrompt
    if (!queued) setStatus('working')
    const deliverPrompt = chooseAgentPromptApi(status, window.agentApi)
    const id = crypto.randomUUID()
    const displayText = text || `${images.length} image${images.length === 1 ? '' : 's'} attached`

    const slot = dispatchGateRef.current.reserve()

    void deliverAgentPrompt(
      text,
      compose,
      async (prompt) => {
        await slot.previous
        const hasText = prompt.length > 0
        if (hasText) pendingSentRef.current.push({ id, text: prompt })
        const content: AgentPromptContent = images.length > 0
          ? [
              ...(hasText ? [{ type: 'text', text: prompt } as const] : []),
              ...images.map((image) => ({ type: 'image', data: image.data, mimeType: image.mimeType }) as const)
            ]
          : prompt
        const result = deliverPrompt(options.id, content)
        slot.release()
        return result
      },
      () => {
        setMessages((current) => [...current, { id, role: 'user', text: displayText, queued }])
        onSent()
      }
    ).then((result) => {
      slot.release()
      if (result.ok) {
        // A pure-image send has no echoed text chunk to clear the queued flag with (see the
        // `message` event branch above), so resolve it here once delivery itself has settled.
        if (images.length > 0 && !text) {
          setMessages((current) => current.map((message) => (message.id === id ? { ...message, queued: false } : message)))
          return
        }
        // Only now that delivery has actually been attempted (a queued send's promise doesn't
        // resolve until the wake gate genuinely dispatches it) is it safe to start the bounded
        // wait for this message's own echo - arming it any earlier would fire while the message
        // is still legitimately queued behind another turn.
        const entry = pendingSentRef.current.find((candidate) => candidate.id === id)
        if (entry && !entry.timer) {
          entry.timer = setTimeout(
            () => clearPendingSent(id),
            options.pendingEchoTimeoutMs ?? DEFAULT_ECHO_TIMEOUT_MS
          )
        }
        return
      }
      setDetail(result.message)
      if (!queued) setStatus('ready')
      markSendFailed(id)
    })
  }

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    dispatchText(draft.trim(), attachments, () => {
      setDraft('')
      setAttachments([])
    })
  }

  const sendMessage = (text: string): void => {
    dispatchText(text.trim(), [], () => {})
  }

  const addImages = async (files: File[] | FileList): Promise<void> => {
    const list = Array.from(files)
    if (list.length === 0) return
    const read = await Promise.all(list.map(async (file): Promise<AgentImageAttachment | null> => {
      try {
        const { data, mimeType } = await readImageAsBase64(file)
        return { id: crypto.randomUUID(), data, mimeType }
      } catch (error) {
        setDetail(error instanceof Error ? error.message : 'Could not read the pasted image.')
        return null
      }
    }))
    const valid = read.filter((attachment): attachment is AgentImageAttachment => attachment !== null)
    if (valid.length > 0) setAttachments((current) => [...current, ...valid])
  }

  const removeAttachment = (id: string): void => {
    setAttachments((current) => current.filter((attachment) => attachment.id !== id))
  }

  const authenticate = (methodId: string): void => {
    setStatus('starting')
    setReauthenticating(true)
    void window.agentApi.authenticate(options.id, methodId).then((result) => {
      if (result.status === 'ready') {
        setStatus('ready')
        setAuthMethods([])
        setAuthLink(null)
      } else {
        setStatus(result.status === 'auth_required' ? 'auth_required' : 'exited')
        setDetail(result.message)
      }
      setReauthenticating(false)
    })
  }

  const openAuthLink = (url: string): void => {
    void window.agentApi.openAuthLink(url)
  }

  const resolveApproval = (approvalId: string, optionId?: string): void => {
    window.agentApi.resolveApproval(options.id, approvalId, optionId)
    setApproval(null)
  }

  const selectMode = async (modeId: string): Promise<boolean> => {
    if (modeId === modes?.currentModeId) return true
    const result = await window.agentApi.setMode(options.id, modeId)
    if (result.ok) {
      setModes((current) => current ? { ...current, currentModeId: modeId } : current)
      onPermissionMode.current(modeId)
      return true
    }
    setDetail(result.message)
    return false
  }

  const selectModel = (modelId: string): void => {
    if (modelId === models?.currentModelId) return
    void window.agentApi.setModel(options.id, modelId).then((result) => {
      if (result.ok) {
        setModels((current) => current ? { ...current, currentModelId: modelId } : current)
        onModel.current(modelId)
      } else {
        setDetail(result.message)
      }
    })
  }

  return {
    messages,
    activities,
    plan,
    approval,
    authMethods: status === 'auth_required' || reauthenticating ? authMethods : [],
    authLink: status === 'auth_required' || reauthenticating ? authLink : null,
    reauthenticating,
    modes,
    models,
    status,
    usage,
    detail,
    draft,
    imageSupport,
    attachments,
    selectorsDisabled: status === 'starting' || status === 'exited',
    setDraft,
    addImages,
    removeAttachment,
    submit,
    sendMessage,
    cancel: () => window.agentApi.cancel(options.id),
    authenticate,
    openAuthLink,
    resolveApproval,
    selectMode,
    selectModel
  }
}

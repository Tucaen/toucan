import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import type {
  AgentActivity,
  AgentAuthMethod,
  AgentCommand,
  AgentEffortState,
  AgentEvent,
  AgentModeState,
  AgentModelState,
  AgentPermissionOption,
  AgentPlanEntry,
  AgentProvider,
  AgentPromptContent
} from '../../shared/agent'
import { mergeActivity } from '../../shared/agent-activity'
import { chooseAgentPromptApi, createDispatchOrderGate, deliverAgentPrompt } from './agent-prompt-delivery'
import {
  editQueuedPrompt,
  enqueuePrompt,
  promptSummary,
  takeQueuedPrompt,
  withdrawQueuedPrompt,
  type QueuedPrompt
} from './prompt-outbox'
import { readImageAsBase64, type AgentImageAttachment } from './image-attachment'
import { mergeSessionUsage, type SessionUsageInput } from './session-usage'

export type { AgentImageAttachment } from './image-attachment'

export interface AgentChatMessage {
  id: string
  role: 'user' | 'assistant' | 'thought'
  text: string
  /** True until the agent actually starts processing this message (only possible for messages sent while busy). */
  queued?: boolean
  /** True if delivery genuinely failed or expired (e.g. a queued send timed out in the wake gate) - never set alongside `queued`. */
  failed?: boolean
  /** Exact pending decision answered through its pinned controls; local UI metadata only. */
  decisionReplyTo?: string
  /** A decision answer has been displayed optimistically but transport has not accepted it yet. */
  deliveryPending?: boolean
  /** False while ACP is still streaming this assistant message; true after turn completion/replay. */
  complete?: boolean
}

export type AgentTranscriptEntry =
  | { type: 'message'; id: string; role: AgentChatMessage['role'] }
  | { type: 'activity'; id: string }

export function agentTranscriptEntryKey(entry: AgentTranscriptEntry): string {
  return entry.type === 'message'
    ? `message:${entry.role}:${entry.id}`
    : `activity:${entry.id}`
}

export interface AgentApprovalState {
  id: string
  title: string
  options: AgentPermissionOption[]
}

/**
 * The latest `usage_update` this session reported, verbatim. What it means for the UI - the
 * percentage, the level, the labels - is `session-usage.ts`'s business, not this hook's.
 */
export type AgentUsage = SessionUsageInput

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
  scope?: 'project'
  sessionId?: string
  permissionMode?: string
  modelId?: string
  effortId?: string
  restartKey?: number
  composePrompt?(text: string): string | Promise<string>
  enabled: boolean
  onSessionId(sessionId: string): void
  onPermissionMode(modeId: string): void
  onModel(modelId: string): void
  onEffort?(effortId?: string): void
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
  /** First-seen event order used to place activity and reasoning inline with dialogue. */
  transcript: AgentTranscriptEntry[]
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
  efforts: AgentEffortState | null
  /** Slash commands and skills this session advertises, for the composer's completion. */
  commands: AgentCommand[]
  status: AgentChatStatus
  usage: AgentUsage | null
  detail?: string
  /**
   * The last reported failure, kept apart from `detail` (which any status message overwrites) so
   * a genuine error stays identifiable long enough to become an attention record.
   */
  failure: string | null
  draft: string
  /** Whether the running agent's ACP handshake advertised support for image content blocks. */
  imageSupport: boolean
  /** Pasted images attached to the draft, shown as removable previews until the message is sent. */
  attachments: AgentImageAttachment[]
  /**
   * Follow-ups submitted while the agent was mid-turn, still held in the renderer. They are
   * deliberately not handed to `promptWhenIdle` yet: a prompt that has crossed into the adapter
   * (steered into the running turn, or parked in the main-process wake gate) can no longer be
   * withdrawn, so holding them here is what makes withdrawal mean anything.
   */
  queued: QueuedPrompt[]
  editQueued(id: string, text: string): void
  withdrawQueued(id: string): void
  /** Hands one queued prompt to the running turn now, instead of waiting for it to finish. */
  sendQueuedNow(id: string): void
  selectorsDisabled: boolean
  setDraft(value: string): void
  addImages(files: File[] | FileList): Promise<void>
  removeAttachment(id: string): void
  submit(event: FormEvent, draftOverride?: string, onPrepared?: () => void): void
  /** Sends `text` as if the captain had typed and submitted it, bypassing the draft/attachments state entirely. */
  sendMessage(text: string): void
  answerDecision(decisionId: string, text: string): void
  cancel(): void
  authenticate(methodId: string): void
  submitAuthCode(code: string): Promise<boolean>
  openAuthLink(url: string): void
  resolveApproval(approvalId: string, optionId?: string): void
  selectMode(modeId: string): Promise<boolean>
  selectModel(modelId: string): void
  selectEffort(effortId: string): void
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
  const [efforts, setEfforts] = useState<AgentEffortState | null>(null)
  const [commands, setCommands] = useState<AgentCommand[]>([])
  const [status, setStatus] = useState<AgentChatStatus>('starting')
  const [failure, setFailure] = useState<string | null>(null)
  const [usage, setUsage] = useState<AgentUsage | null>(null)
  const [detail, setDetail] = useState<string>()
  const [draft, setDraft] = useState('')
  const [imageSupport, setImageSupport] = useState(false)
  const [attachments, setAttachments] = useState<AgentImageAttachment[]>([])
  const [queued, setQueued] = useState<QueuedPrompt[]>([])
  const [transcript, setTranscript] = useState<AgentTranscriptEntry[]>([])
  const transcriptKeysRef = useRef(new Set<string>())
  const rememberTranscriptEntry = (entry: AgentTranscriptEntry): void => {
    const key = agentTranscriptEntryKey(entry)
    if (transcriptKeysRef.current.has(key)) return
    transcriptKeysRef.current.add(key)
    setTranscript((current) => [...current, entry])
  }
  /**
   * The outbox's authoritative copy. Every mutation goes through `updateQueued` so a claim can
   * be made and observed in the same tick; `queued` is the render mirror of it.
   */
  const queuedRef = useRef<QueuedPrompt[]>([])
  const updateQueued = (next: (current: QueuedPrompt[]) => QueuedPrompt[]): void => {
    queuedRef.current = next(queuedRef.current)
    setQueued(queuedRef.current)
  }
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
  const acknowledgePendingSent = (id: string): void => {
    setMessages((current) => current.map((message) => {
      if (message.id !== id) return message
      const { failed: _failed, deliveryPending: _deliveryPending, ...rest } = message
      return { ...rest, queued: false }
    }))
  }
  const clearPendingSent = (id: string): void => {
    const index = pendingSentRef.current.findIndex((entry) => entry.id === id)
    if (index < 0) return
    clearTimeout(pendingSentRef.current[index].timer)
    pendingSentRef.current.splice(index, 1)
    acknowledgePendingSent(id)
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
    }
    setMessages((current) => current.map((message) => (
      message.id === id ? { ...message, queued: false, failed: true, deliveryPending: false } : message
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
  const onEffort = useRef(options.onEffort)

  useEffect(() => { onSessionId.current = options.onSessionId }, [options.onSessionId])
  useEffect(() => { onPermissionMode.current = options.onPermissionMode }, [options.onPermissionMode])
  useEffect(() => { onModel.current = options.onModel }, [options.onModel])
  useEffect(() => { onEffort.current = options.onEffort }, [options.onEffort])

  useEffect(() => {
    if (!options.enabled) return
    let active = true
    transcriptKeysRef.current.clear()
    setTranscript([])
    setMessages([])
    setActivitiesById({})
    setPlan([])
    setApproval(null)
    setAuthMethods([])
    setAuthLink(null)
    setReauthenticating(false)
    setModes(null)
    setModels(null)
    setEfforts(null)
    setCommands([])
    setStatus('starting')
    setUsage(null)
    setDetail(undefined)
    setFailure(null)
    setImageSupport(false)
    setAttachments([])
    updateQueued(() => [])
    const handleEvent = (event: AgentEvent): void => {
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
        rememberTranscriptEntry({ type: 'message', id: event.messageId, role: event.role })
        setMessages((current) => {
          const existing = current.findIndex((message) => message.id === event.messageId && message.role === event.role)
          if (existing < 0) return [...current, {
            id: event.messageId,
            role: event.role,
            text: event.text,
            complete: event.role === 'assistant' ? false : undefined
          }]
          return current.map((message, index) => index === existing ? { ...message, text: message.text + event.text } : message)
        })
      } else if (event.type === 'turn_complete') {
        setMessages((current) => current.map((message) => (
          message.role === 'assistant' && message.complete === false ? { ...message, complete: true } : message
        )))
      } else if (event.type === 'activity') {
        rememberTranscriptEntry({ type: 'activity', id: event.activity.id })
        setActivitiesById((current) => {
          const existing = current[event.activity.id]
          return {
            ...current,
            [event.activity.id]: mergeActivity(existing, event.activity, Date.now())
          }
        })
      } else if (event.type === 'plan') {
        setPlan(event.entries)
      } else if (event.type === 'modes') {
        setModes((current) => event.modes.availableModes.length > 0
          ? event.modes
          : { ...event.modes, availableModes: current?.availableModes ?? [] })
      } else if (event.type === 'models') {
        setModels(event.models)
      } else if (event.type === 'efforts') {
        setEfforts(event.efforts)
        onEffort.current?.(event.efforts?.currentEffortId)
      } else if (event.type === 'commands') {
        setCommands(event.commands)
      } else if (event.type === 'approval') {
        setApproval({ id: event.approvalId, title: event.title, options: event.options })
      } else if (event.type === 'auth') {
        setAuthMethods(event.methods)
        // A fresh auth-required cycle invalidates any sign-in link surfaced by a previous one.
        setAuthLink(null)
      } else if (event.type === 'auth_link') {
        setAuthLink(event.url)
      } else if (event.type === 'usage') {
        // A patch, not a replacement - see mergeSessionUsage.
        setUsage((current) => mergeSessionUsage(current, { used: event.used, size: event.size, cost: event.cost }))
      } else if (event.type === 'error') {
        setDetail(event.message)
        setFailure(event.message)
      }
    }
    const removeListener = window.agentApi.onEvent(options.id, handleEvent)
    void window.agentApi.create({
      id: options.id,
      provider: options.provider,
      cwd: options.cwd,
      scope: options.scope,
      sessionId: options.sessionId,
      permissionMode: options.permissionMode,
      modelId: options.modelId,
      effortId: options.effortId
    }).then((result) => {
      if (!active) return
      for (const event of result.replay ?? []) handleEvent(event)
      if (result.sessionId) onSessionId.current(result.sessionId)
      if (result.authMethods) setAuthMethods(result.authMethods)
      if (result.modes) setModes(result.modes)
      if (result.models) setModels(result.models)
      if (result.efforts) {
        setEfforts(result.efforts)
        onEffort.current?.(result.efforts.currentEffortId)
      }
      if (result.commands) setCommands(result.commands)
      setImageSupport(result.imageSupport ?? false)
      if (result.status === 'ready') {
        // Resume replay is delivered during create(), before this result settles. Those messages
        // are already final even though no new turn_complete notification accompanies replay.
        setMessages((current) => current.map((message) => (
          message.role === 'assistant' && message.complete === false ? { ...message, complete: true } : message
        )))
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
  const dispatchText = (text: string, images: AgentImageAttachment[], onSent: () => void, decisionReplyTo?: string): void => {
    if ((!text && images.length === 0) || (status !== 'ready' && status !== 'working')) return
    const intoRunningTurn = status === 'working'
    const compose = options.composePrompt
    if (!intoRunningTurn) setStatus('working')
    const deliverPrompt = chooseAgentPromptApi(status, window.agentApi)
    const id = crypto.randomUUID()
    const displayText = promptSummary(text, images)
    const transcriptEntry: AgentTranscriptEntry = { type: 'message', id, role: 'user' }

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
        rememberTranscriptEntry(transcriptEntry)
        setMessages((current) => [...current, {
          id,
          role: 'user',
          text: displayText,
          queued: intoRunningTurn,
          decisionReplyTo,
          deliveryPending: decisionReplyTo !== undefined
        }])
        onSent()
      }
    ).then((result) => {
      slot.release()
      if (result.ok) {
        // The transport result is the durable acknowledgement. Keep the text matcher briefly so
        // a later ACP echo is deduplicated, but the UI no longer calls an accepted message queued.
        acknowledgePendingSent(id)
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
      if (!intoRunningTurn) setStatus('ready')
      markSendFailed(id)
    })
  }

  /**
   * A composer submit while the agent is mid-turn parks the prompt in the local outbox instead of
   * delivering it. Everything else - decision answers, `sendMessage` - still goes straight through
   * `promptWhenIdle` (and so straight into the running turn via steering), because those are
   * answers the agent is actively waiting on, not follow-ups the captain may still want back.
   */
  const submit = (event: FormEvent, draftOverride?: string, onPrepared?: () => void): void => {
    event.preventDefault()
    const text = (draftOverride ?? draft).trim()
    const clearComposer = (): void => {
      setDraft('')
      setAttachments([])
      onPrepared?.()
    }
    if (status === 'working' && (text || attachments.length > 0)) {
      updateQueued((current) => enqueuePrompt(current, { id: crypto.randomUUID(), text, images: attachments }))
      clearComposer()
      return
    }
    dispatchText(text, attachments, clearComposer)
  }

  const editQueued = (id: string, text: string): void => {
    updateQueued((current) => editQueuedPrompt(current, id, text))
  }

  const withdrawQueued = (id: string): void => {
    updateQueued((current) => withdrawQueuedPrompt(current, id))
  }

  /**
   * Claims one prompt out of the outbox and dispatches it. The claim reads and writes the ref,
   * not the rendered state, so it settles synchronously: a drain racing a "Send now" (or either
   * racing a withdrawal) can never take the same entry twice or resurrect one already gone.
   */
  const dispatchQueued = (id?: string): void => {
    const { entry, rest } = takeQueuedPrompt(queuedRef.current, id)
    if (!entry) return
    updateQueued(() => rest)
    dispatchText(entry.text, entry.images, () => {})
  }

  const sendQueuedNow = (id: string): void => dispatchQueued(id)

  // The outbox drains one prompt per idle turn: dispatching sets the status back to 'working',
  // so the next entry waits for the turn it just started rather than piling in behind it.
  useEffect(() => {
    if (status !== 'ready' || queued.length === 0) return
    dispatchQueued()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, queued])

  const sendMessage = (text: string): void => {
    dispatchText(text.trim(), [], () => {})
  }

  const answerDecision = (decisionId: string, text: string): void => {
    dispatchText(text.trim(), [], () => {}, decisionId)
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

  const submitAuthCode = async (code: string): Promise<boolean> => {
    const result = await window.agentApi.submitAuthCode(options.id, code)
    if (!result.ok) setDetail(result.message)
    return result.ok
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

  const selectEffort = (effortId: string): void => {
    if (effortId === efforts?.currentEffortId) return
    void window.agentApi.setEffort(options.id, effortId).then((result) => {
      if (result.ok) {
        setEfforts((current) => current ? { ...current, currentEffortId: effortId } : current)
        onEffort.current?.(effortId)
      } else {
        setDetail(result.message)
      }
    })
  }

  return {
    messages,
    activities,
    transcript,
    plan,
    approval,
    authMethods: status === 'auth_required' || reauthenticating ? authMethods : [],
    authLink: status === 'auth_required' || reauthenticating ? authLink : null,
    reauthenticating,
    modes,
    models,
    efforts,
    commands,
    status,
    usage,
    detail,
    failure,
    draft,
    imageSupport,
    attachments,
    queued,
    editQueued,
    withdrawQueued,
    sendQueuedNow,
    selectorsDisabled: status === 'starting' || status === 'exited',
    setDraft,
    addImages,
    removeAttachment,
    submit,
    sendMessage,
    answerDecision,
    cancel: () => window.agentApi.cancel(options.id),
    authenticate,
    submitAuthCode,
    openAuthLink,
    resolveApproval,
    selectMode,
    selectModel,
    selectEffort
  }
}

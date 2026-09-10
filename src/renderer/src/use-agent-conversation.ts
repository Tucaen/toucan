import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import type {
  AgentActivity,
  AgentAuthMethod,
  AgentCommand,
  AgentDecisionRequest,
  AgentDecisionResponseContent,
  AgentEffortState,
  AgentEvent,
  AgentModeState,
  AgentModelState,
  AgentPlanEntry,
  AgentProvider,
  AgentPromptContent,
  AgentTurnOutcome
} from '../../shared/agent'
import type { AgentRoutineDelegation, RoutineDelegationRequest } from '../../shared/routine-delegation'
import {
  applyAgentCreateResult,
  foldAgentEvent,
  initialAgentTranscriptState,
  type AgentApprovalState,
  type AgentChatMessage,
  type AgentChatStatus,
  type AgentTranscriptEntry,
  type AgentTranscriptState,
  type LocalAgentEvent
} from '../../shared/agent-transcript'
import type { SessionUsageInput } from './session-usage'
import { chooseAgentPromptApi, createDispatchOrderGate, deliverAgentPrompt } from './agent-prompt-delivery'
import {
  editQueuedPrompt,
  enqueuePrompt,
  takeQueuedPrompt,
  withdrawQueuedPrompt,
  type QueuedPrompt
} from './prompt-outbox'
import { readImageAsBase64, type AgentImageAttachment } from './image-attachment'

export type { AgentImageAttachment } from './image-attachment'
export { agentTranscriptEntryKey } from '../../shared/agent-transcript'
export type {
  AgentApprovalState,
  AgentChatMessage,
  AgentChatStatus,
  AgentTranscriptEntry
} from '../../shared/agent-transcript'

/**
 * The latest `usage_update` this session reported, verbatim. What it means for the UI - the
 * percentage, the level, the labels - is `session-usage.ts`'s business, not this hook's.
 */
export type AgentUsage = SessionUsageInput

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
  /** The routine-delegation policy to launch with; read at create time, never a restart trigger. */
  routineDelegation?: RoutineDelegationRequest
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
  /** Failed and cancelled turn boundaries, retained as visible transcript entries. */
  outcomes: AgentTurnOutcome[]
  /** First-seen event order used to place activity and reasoning inline with dialogue. */
  transcript: AgentTranscriptEntry[]
  plan: AgentPlanEntry[]
  approval: AgentApprovalState | null
  decisionRequest: AgentDecisionRequest | null
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
  /** The routine-delegation policy the session's adapter launched with; null before it reports. */
  routineDelegation: AgentRoutineDelegation | null
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
  /** Stable identity for a turn-scoped failure; generic session errors fall back to their text. */
  failureKey: string | null
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
  resolveElicitation(requestId: string, content?: AgentDecisionResponseContent): void
  selectMode(modeId: string): Promise<boolean>
  selectModel(modelId: string): void
  selectEffort(effortId: string): void
}

/**
 * Thin React wrapper over the shared transcript reducer (`src/shared/agent-transcript.ts`): every
 * write to conversation state - main's `AgentEvent`s, live or replayed, and this renderer's own
 * `LocalAgentEvent`s (optimistic prompt start, selections, answered requests, delivery flags) -
 * folds through `foldAgentEvent`, so this hook owns only what is genuinely renderer-local (the
 * composer draft and attachments, the prompt outbox, echo bookkeeping, and the IPC calls
 * themselves).
 */
export function useAgentConversation(options: AgentConversationOptions): AgentConversationController {
  const [chat, setChat] = useState<AgentTranscriptState>(initialAgentTranscriptState)
  const [reauthenticating, setReauthenticating] = useState(false)
  const [draft, setDraft] = useState('')
  const [imageSupport, setImageSupport] = useState(false)
  const [attachments, setAttachments] = useState<AgentImageAttachment[]>([])
  const [queued, setQueued] = useState<QueuedPrompt[]>([])
  const { status } = chat
  const fold = (event: AgentEvent | LocalAgentEvent): void =>
    setChat((current) => foldAgentEvent(current, event, Date.now()))
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
    fold({ type: 'local_message_delivered', messageId: id })
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
  const markSendFailed = (id: string, hasEchoableText: boolean): void => {
    const index = pendingSentRef.current.findIndex((entry) => entry.id === id)
    // `prompt()` settles with the whole turn, not merely prompt acceptance. An earlier ACP user
    // echo removes this tracked entry and is stronger delivery evidence than a later failed-turn
    // result, so never regress an acknowledged message back to "not sent". Image-only sends have
    // no text echo to track and must still surface a rejected transport result.
    if (hasEchoableText && index < 0) return
    if (index >= 0) {
      clearTimeout(pendingSentRef.current[index].timer)
    }
    fold({ type: 'local_send_failed', messageId: id })
  }
  /**
   * Serializes the actual cross-process deliver call in submission order, even when an earlier
   * submit's (async) composePrompt resolves after a later one's.
   */
  const dispatchGateRef = useRef(createDispatchOrderGate())
  const activities = useMemo(() => Object.values(chat.activities), [chat.activities])
  const onSessionId = useRef(options.onSessionId)
  const onPermissionMode = useRef(options.onPermissionMode)
  const onModel = useRef(options.onModel)
  const onEffort = useRef(options.onEffort)

  useEffect(() => {
    onSessionId.current = options.onSessionId
  }, [options.onSessionId])
  useEffect(() => {
    onPermissionMode.current = options.onPermissionMode
  }, [options.onPermissionMode])
  useEffect(() => {
    onModel.current = options.onModel
  }, [options.onModel])
  useEffect(() => {
    onEffort.current = options.onEffort
  }, [options.onEffort])

  useEffect(() => {
    if (!options.enabled) return
    let active = true
    setChat(initialAgentTranscriptState())
    setReauthenticating(false)
    setImageSupport(false)
    setAttachments([])
    updateQueued(() => [])
    const handleEvent = (event: AgentEvent): void => {
      if (!active) return
      if (event.type === 'message' && event.role === 'user') {
        // The echo of an optimistically rendered local send: consume it instead of folding a
        // duplicate. Hosts without optimistic sends fold the echo as the message itself.
        const sent = pendingSentRef.current.find((entry) => entry.text === event.text)
        if (sent) {
          clearPendingSent(sent.id)
          return
        }
      }
      if (event.type === 'session') onSessionId.current(event.sessionId)
      if (event.type === 'efforts') onEffort.current?.(event.efforts?.currentEffortId)
      fold(event)
    }
    const removeListener = window.agentApi.onEvent(options.id, handleEvent)
    void window.agentApi
      .create({
        id: options.id,
        provider: options.provider,
        cwd: options.cwd,
        scope: options.scope,
        sessionId: options.sessionId,
        permissionMode: options.permissionMode,
        modelId: options.modelId,
        effortId: options.effortId,
        routineDelegation: options.routineDelegation
      })
      .then((result) => {
        if (!active) return
        // Resume replay is delivered during create(), before this result settles. It folds through
        // the same handler (and so the same reducer path) as live events.
        for (const event of result.replay ?? []) handleEvent(event)
        if (result.sessionId) onSessionId.current(result.sessionId)
        if (result.efforts) onEffort.current?.(result.efforts.currentEffortId)
        setImageSupport(result.imageSupport ?? false)
        setChat((current) => applyAgentCreateResult(current, result))
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
  const dispatchText = (
    text: string,
    images: AgentImageAttachment[],
    onSent: () => void,
    decisionReplyTo?: string
  ): void => {
    if ((!text && images.length === 0) || (status !== 'ready' && status !== 'working')) return
    const intoRunningTurn = status === 'working'
    const compose = options.composePrompt
    if (!intoRunningTurn) fold({ type: 'local_prompt_started' })
    const deliverPrompt = chooseAgentPromptApi(status, window.agentApi)
    const id = crypto.randomUUID()

    const slot = dispatchGateRef.current.reserve()

    void deliverAgentPrompt(
      text,
      compose,
      async (prompt) => {
        await slot.previous
        const hasText = prompt.length > 0
        if (hasText) pendingSentRef.current.push({ id, text: prompt })
        const content: AgentPromptContent =
          images.length > 0
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
        fold({
          type: 'local_user_message',
          message: {
            id,
            role: 'user',
            // The images themselves are the message's visible body when no text was typed, so
            // the transcript never needs `promptSummary`'s "N images attached" stand-in.
            text,
            ...(images.length > 0 ? { images } : {}),
            queued: intoRunningTurn,
            decisionReplyTo,
            deliveryPending: decisionReplyTo !== undefined
          }
        })
        onSent()
      }
    ).then((result) => {
      slot.release()
      if (result.ok) {
        // The transport result is the durable acknowledgement. Keep the text matcher briefly so
        // a later ACP echo is deduplicated, but the UI no longer calls an accepted message queued.
        acknowledgePendingSent(id)
        // A pure-image send has no echoed text chunk to wait on (see the `message` event branch
        // above): the transport result above already resolved its queued flag, so skip the timer.
        if (images.length > 0 && !text) return
        // Only now that delivery has actually been attempted (a queued send's promise doesn't
        // resolve until the wake gate genuinely dispatches it) is it safe to start the bounded
        // wait for this message's own echo - arming it any earlier would fire while the message
        // is still legitimately queued behind another turn.
        const entry = pendingSentRef.current.find((candidate) => candidate.id === id)
        if (entry && !entry.timer) {
          entry.timer = setTimeout(() => clearPendingSent(id), options.pendingEchoTimeoutMs ?? DEFAULT_ECHO_TIMEOUT_MS)
        }
        return
      }
      // The reducer owns the precedence between this verdict and main's own status events (issue
      // #156). A send steered into a running turn never started the optimistic `working`, so its
      // failure is only a notice.
      fold(
        intoRunningTurn
          ? { type: 'local_detail', message: result.message }
          : { type: 'local_prompt_failed', message: result.message }
      )
      markSendFailed(id, Boolean(result.prompt))
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
    const read = await Promise.all(
      list.map(async (file): Promise<AgentImageAttachment | null> => {
        try {
          const { data, mimeType } = await readImageAsBase64(file)
          return { id: crypto.randomUUID(), data, mimeType }
        } catch (error) {
          fold({
            type: 'local_detail',
            message: error instanceof Error ? error.message : 'Could not read the pasted image.'
          })
          return null
        }
      })
    )
    const valid = read.filter((attachment): attachment is AgentImageAttachment => attachment !== null)
    if (valid.length > 0) setAttachments((current) => [...current, ...valid])
  }

  const removeAttachment = (id: string): void => {
    setAttachments((current) => current.filter((attachment) => attachment.id !== id))
  }

  const authenticate = (methodId: string): void => {
    fold({ type: 'local_auth_started' })
    setReauthenticating(true)
    void window.agentApi.authenticate(options.id, methodId).then((result) => {
      fold({ type: 'local_auth_settled', status: result.status, message: result.message })
      setReauthenticating(false)
    })
  }

  const openAuthLink = (url: string): void => {
    void window.agentApi.openAuthLink(url)
  }

  const submitAuthCode = async (code: string): Promise<boolean> => {
    const result = await window.agentApi.submitAuthCode(options.id, code)
    if (!result.ok) fold({ type: 'local_detail', message: result.message })
    return result.ok
  }

  const resolveApproval = (approvalId: string, optionId?: string): void => {
    window.agentApi.resolveApproval(options.id, approvalId, optionId)
    fold({ type: 'local_approval_resolved', approvalId })
  }

  const resolveElicitation = (requestId: string, content?: AgentDecisionResponseContent): void => {
    window.agentApi.resolveElicitation(options.id, requestId, content)
    fold({ type: 'local_decision_resolved', requestId })
  }

  const selectMode = async (modeId: string): Promise<boolean> => {
    if (modeId === chat.modes?.currentModeId) return true
    const result = await window.agentApi.setMode(options.id, modeId)
    if (result.ok) {
      fold({ type: 'local_mode_selected', modeId })
      onPermissionMode.current(modeId)
      return true
    }
    fold({ type: 'local_detail', message: result.message })
    return false
  }

  const selectModel = (modelId: string): void => {
    if (modelId === chat.models?.currentModelId) return
    void window.agentApi.setModel(options.id, modelId).then((result) => {
      if (result.ok) {
        fold({ type: 'local_model_selected', modelId })
        onModel.current(modelId)
      } else {
        fold({ type: 'local_detail', message: result.message })
      }
    })
  }

  const selectEffort = (effortId: string): void => {
    if (effortId === chat.efforts?.currentEffortId) return
    void window.agentApi.setEffort(options.id, effortId).then((result) => {
      if (result.ok) {
        fold({ type: 'local_effort_selected', effortId })
        onEffort.current?.(effortId)
      } else {
        fold({ type: 'local_detail', message: result.message })
      }
    })
  }

  return {
    messages: chat.messages,
    activities,
    outcomes: chat.outcomes,
    transcript: chat.transcript,
    plan: chat.plan,
    approval: chat.approval,
    decisionRequest: chat.decisionRequests[0] ?? null,
    authMethods: chat.authMethods,
    authLink: chat.authLink,
    reauthenticating,
    modes: chat.modes,
    models: chat.models,
    efforts: chat.efforts,
    routineDelegation: chat.routineDelegation,
    commands: chat.commands,
    status,
    usage: chat.usage,
    detail: chat.detail,
    failure: chat.failure,
    failureKey: chat.failureKey,
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
    resolveElicitation,
    selectMode,
    selectModel,
    selectEffort
  }
}

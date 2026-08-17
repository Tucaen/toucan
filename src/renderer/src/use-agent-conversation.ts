import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import type {
  AgentActivity,
  AgentAuthMethod,
  AgentEvent,
  AgentModeState,
  AgentModelState,
  AgentPermissionOption,
  AgentPlanEntry,
  AgentProvider
} from '../../shared/agent'
import { chooseAgentPromptApi, deliverAgentPrompt } from './agent-prompt-delivery'

export interface AgentChatMessage {
  id: string
  role: 'user' | 'assistant' | 'thought'
  text: string
  /** True until the agent actually starts processing this message (only possible for messages sent while busy). */
  queued?: boolean
}

export interface AgentApprovalState {
  id: string
  title: string
  options: AgentPermissionOption[]
}

export type AgentChatStatus = 'starting' | 'ready' | 'working' | 'auth_required' | 'exited'

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
}

export interface AgentConversationController {
  messages: AgentChatMessage[]
  activities: AgentActivity[]
  plan: AgentPlanEntry[]
  approval: AgentApprovalState | null
  authMethods: AgentAuthMethod[]
  modes: AgentModeState | null
  models: AgentModelState | null
  status: AgentChatStatus
  detail?: string
  draft: string
  selectorsDisabled: boolean
  setDraft(value: string): void
  submit(event: FormEvent): void
  cancel(): void
  authenticate(methodId: string): void
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
  const [modes, setModes] = useState<AgentModeState | null>(null)
  const [models, setModels] = useState<AgentModelState | null>(null)
  const [status, setStatus] = useState<AgentChatStatus>('starting')
  const [detail, setDetail] = useState<string>()
  const [draft, setDraft] = useState('')
  /** FIFO of messages sent but not yet echoed back, so each queued send (not just the latest) clears its own queued flag. */
  const pendingSentRef = useRef<Array<{ id: string; text: string }>>([])
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
    setModes(null)
    setModels(null)
    setStatus('starting')
    setDetail(undefined)
    const removeListener = window.agentApi.onEvent(options.id, (event: AgentEvent) => {
      if (!active) return
      if (event.type === 'status') {
        setStatus(event.status === 'idle' ? 'ready' : event.status)
        setDetail(event.message)
      } else if (event.type === 'session') {
        onSessionId.current(event.sessionId)
      } else if (event.type === 'message') {
        if (event.role === 'user' && pendingSentRef.current[0]?.text === event.text) {
          const sent = pendingSentRef.current.shift()!
          setMessages((current) => current.map((message) => (
            message.id === sent.id ? { ...message, queued: false } : message
          )))
          return
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
    }
  }, [options.cwd, options.enabled, options.id, options.provider, options.restartKey, options.scope])

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    const text = draft.trim()
    if (!text || (status !== 'ready' && status !== 'working')) return
    const queued = status === 'working'
    const compose = options.composePrompt
    if (!queued) setStatus('working')
    const deliverPrompt = chooseAgentPromptApi(status, window.agentApi)
    const id = crypto.randomUUID()
    void deliverAgentPrompt(
      text,
      compose,
      (prompt) => deliverPrompt(options.id, prompt),
      (prompt) => {
        setMessages((current) => [...current, { id, role: 'user', text, queued }])
        setDraft('')
        pendingSentRef.current.push({ id, text: prompt })
      }
    ).then((result) => {
      if (result.ok) return
      setDetail(result.message)
      if (!queued) setStatus('ready')
      pendingSentRef.current = pendingSentRef.current.filter((entry) => entry.id !== id)
    })
  }

  const authenticate = (methodId: string): void => {
    setStatus('starting')
    void window.agentApi.authenticate(options.id, methodId).then((result) => {
      if (result.status === 'ready') {
        setStatus('ready')
        setAuthMethods([])
      } else {
        setStatus(result.status === 'auth_required' ? 'auth_required' : 'exited')
        setDetail(result.message)
      }
    })
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
    authMethods: status === 'auth_required' ? authMethods : [],
    modes,
    models,
    status,
    detail,
    draft,
    selectorsDisabled: status === 'starting' || status === 'exited',
    setDraft,
    submit,
    cancel: () => window.agentApi.cancel(options.id),
    authenticate,
    resolveApproval,
    selectMode,
    selectModel
  }
}

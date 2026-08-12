import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { type NodeProps } from '@xyflow/react'
import ReactMarkdown from 'react-markdown'
import type {
  AgentActivity,
  AgentAuthMethod,
  AgentEvent,
  AgentModeState,
  AgentPermissionOption,
  AgentPlanEntry
} from '../../shared/agent'
import { activityTitle } from '../../shared/agent-activity'
import type { TerminalCanvasNode } from './canvas-workspace'
import NodeBorderResizer from './NodeBorderResizer'

interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'thought'
  text: string
}

interface ApprovalState {
  id: string
  title: string
  options: AgentPermissionOption[]
}

interface ChatViewProps {
  provider: 'claude' | 'codex'
  messages: ChatMessage[]
  activities: AgentActivity[]
  plan: AgentPlanEntry[]
  approval: ApprovalState | null
  authMethods: AgentAuthMethod[]
  status: string
  detail?: string
  draft: string
  setDraft(value: string): void
  submit(event: FormEvent): void
  cancel(): void
  authenticate(methodId: string): void
  resolveApproval(approvalId: string, optionId?: string): void
}

const providerNames = { claude: 'Claude', codex: 'Codex' } as const

function PermissionModePicker(props: {
  modes: AgentModeState | null
  disabled: boolean
  selectMode(modeId: string): void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const selectedMode = props.modes?.availableModes.find((mode) => mode.id === props.modes?.currentModeId)
  const canOpen = Boolean(props.modes?.availableModes.length) && !props.disabled

  return (
    <div
      className="permission-mode-picker nodrag"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false)
      }}
      onClick={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        className="permission-mode-button"
        aria-expanded={open}
        aria-haspopup="listbox"
        disabled={!canOpen}
        title={selectedMode?.description ?? 'Set the permission mode for this agent'}
        onClick={() => setOpen((current) => !current)}
      >
        <span aria-hidden="true">*</span>
        {selectedMode?.name ?? 'Permissions'}
        <span aria-hidden="true">⌄</span>
      </button>
      {open && props.modes && (
        <div className="permission-mode-menu" role="listbox" aria-label="Agent permission mode">
          <small>Permission mode</small>
          {props.modes.availableModes.map((mode) => (
            <button
              type="button"
              role="option"
              aria-selected={mode.id === props.modes?.currentModeId}
              data-selected={mode.id === props.modes?.currentModeId}
              key={mode.id}
              onClick={() => {
                props.selectMode(mode.id)
                setOpen(false)
              }}
            >
              <strong>{mode.name}</strong>
              {mode.description && <span>{mode.description}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function Markdown({ text }: { text: string }): JSX.Element {
  return <ReactMarkdown>{text}</ReactMarkdown>
}

function EmptyConversation({ provider }: Pick<ChatViewProps, 'provider'>): JSX.Element {
  return (
    <div className="chat-empty">
      <span>{provider === 'claude' ? 'C' : '<>'}</span>
      <strong>Start a conversation</strong>
      <p>Ask {providerNames[provider]} to explore, explain, or change this project.</p>
    </div>
  )
}

function Composer(props: Pick<ChatViewProps, 'draft' | 'setDraft' | 'submit' | 'cancel' | 'status'>): JSX.Element {
  const busy = props.status === 'working'
  return (
    <form className="chat-composer nodrag" onSubmit={props.submit}>
      <textarea
        value={props.draft}
        onChange={(event) => props.setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault()
            event.currentTarget.form?.requestSubmit()
          }
        }}
        placeholder={busy ? 'Agent is working...' : 'Message the agent...'}
        disabled={busy || props.status === 'starting' || props.status === 'auth_required'}
      />
      {busy
        ? <button type="button" className="stop-agent" onClick={props.cancel}>Stop</button>
        : <button type="submit" disabled={!props.draft.trim() || props.status !== 'ready'}>Send</button>}
    </form>
  )
}

function AuthPanel(props: Pick<ChatViewProps, 'provider' | 'authMethods' | 'authenticate'>): JSX.Element | null {
  if (props.authMethods.length === 0) return null
  const subscriptionMethods = props.authMethods.filter((method) => (
    method.name.toLocaleLowerCase().includes('chatgpt')
    || method.name.toLocaleLowerCase().includes('subscription')
    || method.name.toLocaleLowerCase().includes('claude')
  ))
  const methods = subscriptionMethods.length > 0 ? subscriptionMethods : props.authMethods
  return (
    <section className="chat-auth-panel">
      <span className="auth-lock">*</span>
      <div>
        <strong>Connect {providerNames[props.provider]}</strong>
        <p>Use your existing subscription login. API credentials are optional.</p>
        {methods.map((method) => (
          <button type="button" key={method.id} onClick={() => props.authenticate(method.id)}>
            {method.name}
          </button>
        ))}
      </div>
    </section>
  )
}

function ApprovalPanel(props: Pick<ChatViewProps, 'approval' | 'resolveApproval'>): JSX.Element | null {
  if (!props.approval) return null
  return (
    <section className="chat-approval-panel">
      <span>Permission requested</span>
      <strong>{props.approval.title}</strong>
      <div>
        {props.approval.options.map((option) => (
          <button
            type="button"
            data-kind={option.kind}
            key={option.id}
            onClick={() => props.resolveApproval(props.approval!.id, option.id)}
          >
            {option.label}
          </button>
        ))}
        <button type="button" onClick={() => props.resolveApproval(props.approval!.id)}>Cancel</button>
      </div>
    </section>
  )
}

function ActivityCard({ activity }: { activity: AgentActivity }): JSX.Element {
  return (
    <article className="activity-card" data-status={activity.status}>
      <span className="activity-icon">{activity.kind === 'edit' ? '+' : activity.kind === 'execute' ? '>_' : '*'}</span>
      <div>
        <strong>{activityTitle(activity)}</strong>
        {activity.content && <pre>{activity.content}</pre>}
        {activity.locations?.map((location) => <small key={location}>{location}</small>)}
      </div>
      <span className="activity-state">{activity.status?.replace('_', ' ')}</span>
    </article>
  )
}

function ChatView(props: ChatViewProps & {
  worklogCollapsed: boolean
  setWorklogCollapsed(collapsed: boolean): void
}): JSX.Element {
  const workItemCount = props.activities.length + props.plan.length
  return (
    <div className={`agent-chat ${props.worklogCollapsed ? 'worklog-collapsed' : ''}`}>
      <div className="chat-scroll nodrag nopan nowheel">
        {props.messages.length === 0 && <EmptyConversation provider={props.provider} />}
        {props.messages.map((message) => message.role === 'thought'
          ? <details className="thought-card" key={message.id}><summary>Reasoning</summary><Markdown text={message.text} /></details>
          : (
            <article className={`chat-message ${message.role}`} key={message.id}>
              <span>{message.role === 'user' ? 'You' : providerNames[props.provider]}</span>
              <div><Markdown text={message.text} /></div>
            </article>
          ))}
        <ApprovalPanel {...props} />
        <AuthPanel {...props} />
      </div>
      <aside className="worklog-rail nodrag nopan nowheel">
        {props.worklogCollapsed ? (
          <button
            type="button"
            className="worklog-expand"
            aria-label="Show worklog"
            aria-expanded="false"
            onClick={() => props.setWorklogCollapsed(false)}
          >
            <span>{'<'}</span>
            <strong>Worklog</strong>
            <small>{workItemCount}</small>
          </button>
        ) : (
          <>
            <div className="worklog-heading">
              <span>Worklog</span>
              <small>{props.activities.length} actions</small>
              <button
                type="button"
                aria-label="Hide worklog"
                aria-expanded="true"
                title="Hide worklog"
                onClick={() => props.setWorklogCollapsed(true)}
              >
                {'>'}
              </button>
            </div>
            {props.plan.length > 0 && (
              <ol className="plan-list">
                {props.plan.map((entry, index) => <li data-status={entry.status} key={`${index}-${entry.content}`}>{entry.content}</li>)}
              </ol>
            )}
            {props.activities.map((activity) => <ActivityCard activity={activity} key={activity.id} />)}
            {workItemCount === 0 && <p className="worklog-empty">Agent plans and activity will appear here.</p>}
          </>
        )}
      </aside>
      <Composer {...props} />
    </div>
  )
}

export default function ChatNode({ id, data, selected }: NodeProps<TerminalCanvasNode>): JSX.Element {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [activitiesById, setActivitiesById] = useState<Record<string, AgentActivity>>({})
  const [plan, setPlan] = useState<AgentPlanEntry[]>([])
  const [approval, setApproval] = useState<ApprovalState | null>(null)
  const [authMethods, setAuthMethods] = useState<AgentAuthMethod[]>([])
  const [modes, setModes] = useState<AgentModeState | null>(null)
  const [status, setStatus] = useState<'starting' | 'ready' | 'working' | 'auth_required' | 'exited'>('starting')
  const [detail, setDetail] = useState<string>()
  const [draft, setDraft] = useState('')
  const sentTextRef = useRef<string>()
  const provider = data.kind === 'claude' ? 'claude' : 'codex'
  const activities = useMemo(() => Object.values(activitiesById), [activitiesById])

  useEffect(() => {
    if (data.dormant) return
    let active = true
    const removeListener = window.agentApi.onEvent(id, (event: AgentEvent) => {
      if (!active) return
      if (event.type === 'status') {
        setStatus(event.status === 'idle' ? 'ready' : event.status)
        setDetail(event.message)
        if (event.status === 'working' || event.status === 'ready' || event.status === 'idle') {
          data.onStatusChange(id, 'running')
        } else if (event.status === 'auth_required') {
          data.onStatusChange(id, 'attention')
        } else if (event.status === 'exited') {
          data.onStatusChange(id, 'exited')
        }
      } else if (event.type === 'session') {
        data.onConversationId(id, event.sessionId)
      } else if (event.type === 'message') {
        if (event.role === 'user' && sentTextRef.current === event.text) {
          sentTextRef.current = undefined
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
      } else if (event.type === 'approval') {
        setApproval({ id: event.approvalId, title: event.title, options: event.options })
      } else if (event.type === 'auth') {
        setAuthMethods(event.methods)
      } else if (event.type === 'error') {
        setDetail(event.message)
      }
    })
    void window.agentApi.create({
      id,
      provider,
      cwd: data.projectPath,
      sessionId: data.launchMode === 'resume' ? data.conversationId : undefined
    }).then((result) => {
      if (!active) return
      if (result.sessionId) data.onConversationId(id, result.sessionId)
      if (result.authMethods) setAuthMethods(result.authMethods)
      if (result.modes) setModes(result.modes)
      if (result.status === 'ready') {
        setStatus('ready')
        data.onStatusChange(id, 'running')
      } else if (result.status === 'auth_required') {
        setStatus('auth_required')
        data.onStatusChange(id, 'attention')
      } else {
        setStatus('exited')
        setDetail(result.message)
        data.onStatusChange(id, 'exited')
      }
    })
    return () => {
      active = false
      removeListener()
      window.agentApi.kill(id)
    }
  }, [data.dormant, data.launchMode, data.projectPath, id, provider])

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    const text = draft.trim()
    if (!text || status !== 'ready') return
    const messageId = crypto.randomUUID()
    sentTextRef.current = text
    setMessages((current) => [...current, { id: messageId, role: 'user', text }])
    setDraft('')
    setStatus('working')
    void window.agentApi.prompt(id, text).then((result) => {
      if (!result.ok) setDetail(result.message)
    })
  }

  const authenticate = (methodId: string): void => {
    setStatus('starting')
    void window.agentApi.authenticate(id, methodId).then((result) => {
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
    window.agentApi.resolveApproval(id, approvalId, optionId)
    setApproval(null)
  }

  const selectMode = (modeId: string): void => {
    if (modeId === modes?.currentModeId) return
    void window.agentApi.setMode(id, modeId).then((result) => {
      if (result.ok) {
        setModes((current) => current ? { ...current, currentModeId: modeId } : current)
      } else {
        setDetail(result.message)
      }
    })
  }

  const props: ChatViewProps = {
    provider,
    messages,
    activities,
    plan,
    approval,
    authMethods: status === 'auth_required' ? authMethods : [],
    status,
    detail,
    draft,
    setDraft,
    submit,
    cancel: () => window.agentApi.cancel(id),
    authenticate,
    resolveApproval
  }

  return (
    <article
      className={`terminal-node chat-node ${selected ? 'selected' : ''}`}
      style={{ '--node-accent': provider === 'claude' ? '#e69a71' : '#71a9ff', '--project-color': data.projectColor } as React.CSSProperties}
    >
      <NodeBorderResizer minWidth={420} minHeight={320} selected={selected} color={data.projectColor} />
      <header className="node-header chat-node-header">
        <span className="status-dot" data-status={status} />
        <strong>{data.label}</strong>
        <span className="node-project" title={data.projectPath}><span className="project-color-dot" />{data.projectName}</span>
        {!data.dormant && (
          <PermissionModePicker
            modes={modes}
            disabled={status === 'starting' || status === 'auth_required' || status === 'exited'}
            selectMode={selectMode}
          />
        )}
        <span className="chat-provider-badge">ACP</span>
        <span className="node-status">{status.replace('_', ' ')}</span>
      </header>
      {data.dormant ? (
        <div className="dormant-session chat-dormant nodrag">
          <span className="dormant-session-icon">{provider === 'claude' ? 'C' : '<>'}</span>
          <strong>Saved {providerNames[provider]} conversation</strong>
          <small>{data.conversationId ? 'Load its ACP history and continue where you left off.' : 'Start a new ACP conversation.'}</small>
          {data.preview?.assistant && <blockquote>{data.preview.assistant}</blockquote>}
          <button type="button" className="resume-session" onClick={() => data.onResume(id)}>
            {data.conversationId ? 'Open conversation' : 'Start conversation'}
          </button>
        </div>
      ) : (
        <>
          <ChatView
            {...props}
            worklogCollapsed={data.worklogCollapsed}
            setWorklogCollapsed={(collapsed) => data.onWorklogCollapsed(id, collapsed)}
          />
          {detail && <div className="chat-detail" title={detail}>{detail}</div>}
        </>
      )}
    </article>
  )
}

// Three variants of the ACP chat node, switchable via ?variant=, on the existing canvas route.
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { NodeResizer, type NodeProps } from '@xyflow/react'
import ReactMarkdown from 'react-markdown'
import type {
  AgentActivity,
  AgentAuthMethod,
  AgentEvent,
  AgentPermissionOption,
  AgentPlanEntry
} from '../../shared/agent'
import type { TerminalCanvasNode } from './canvas-workspace'
import { useChatPrototypeVariant } from './PrototypeSwitcher'

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

const examplePlan: AgentPlanEntry[] = [
  { content: 'Inspect how saved agent sessions are resumed', priority: 'high', status: 'completed' },
  { content: 'Normalize provider events into one chat model', priority: 'high', status: 'completed' },
  { content: 'Update the node UI and process launcher', priority: 'high', status: 'in_progress' },
  { content: 'Run type checks, tests, and a production build', priority: 'medium', status: 'pending' }
]

const exampleActivities: AgentActivity[] = [
  {
    id: 'example-search',
    title: 'Searched for the session resume path',
    kind: 'search',
    status: 'completed',
    content: '12 matches across 5 files'
  },
  {
    id: 'example-read',
    title: 'Inspected the Claude adapter launcher',
    kind: 'read',
    status: 'completed',
    locations: ['node_modules/@agentclientprotocol/claude-agent-acp/dist/acp-agent.js']
  },
  {
    id: 'example-edit',
    title: 'Updated the shared ACP session manager',
    kind: 'edit',
    status: 'completed',
    locations: ['src/main/acp-session-manager.ts']
  },
  {
    id: 'example-test',
    title: 'Running the regression tests',
    kind: 'execute',
    status: 'in_progress',
    content: '12 passed, 2 still running'
  }
]

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
        <strong>{activity.title}</strong>
        {activity.content && <pre>{activity.content}</pre>}
        {activity.locations?.map((location) => <small key={location}>{location}</small>)}
      </div>
      <span className="activity-state">{activity.status?.replace('_', ' ')}</span>
    </article>
  )
}

export function VariantA(props: ChatViewProps): JSX.Element {
  return (
    <div className="chat-variant chat-variant-a">
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
        {props.activities.length > 0 && (
          <section className="inline-activities">
            {props.activities.map((activity) => <ActivityCard activity={activity} key={activity.id} />)}
          </section>
        )}
        <ApprovalPanel {...props} />
        <AuthPanel {...props} />
      </div>
      <Composer {...props} />
    </div>
  )
}

export function VariantB(props: ChatViewProps): JSX.Element {
  const conversation = props.messages.filter((message) => message.role !== 'thought')
  const showExamples = props.plan.length === 0 && props.activities.length === 0
  const displayedPlan = showExamples ? examplePlan : props.plan
  const displayedActivities = showExamples ? exampleActivities : props.activities
  return (
    <div className="chat-variant chat-variant-b">
      <section className="worklog-conversation nodrag nopan nowheel">
        <div className="worklog-heading"><span>Conversation</span><small>{conversation.length} messages</small></div>
        {conversation.length === 0 && <EmptyConversation provider={props.provider} />}
        {conversation.map((message) => (
          <article className={`worklog-message ${message.role}`} key={message.id}>
            <strong>{message.role === 'user' ? 'You' : providerNames[props.provider]}</strong>
            <Markdown text={message.text} />
          </article>
        ))}
        <ApprovalPanel {...props} />
        <AuthPanel {...props} />
      </section>
      <aside className="worklog-rail nodrag nopan nowheel">
        <div className="worklog-heading">
          <span>Worklog</span>
          <small>{showExamples ? 'example preview' : `${props.activities.length} actions`}</small>
        </div>
        {showExamples && (
          <p className="worklog-example-note">Sample data - replaced as soon as the agent reports real work.</p>
        )}
        {displayedPlan.length > 0 && (
          <ol className="plan-list">
            {displayedPlan.map((entry, index) => <li data-status={entry.status} key={`${index}-${entry.content}`}>{entry.content}</li>)}
          </ol>
        )}
        {displayedActivities.map((activity) => <ActivityCard activity={activity} key={activity.id} />)}
      </aside>
      <Composer {...props} />
    </div>
  )
}

export function VariantC(props: ChatViewProps): JSX.Element {
  const latestAssistant = [...props.messages].reverse().find((message) => message.role === 'assistant')
  const userMessages = props.messages.filter((message) => message.role === 'user')
  return (
    <div className="chat-variant chat-variant-c">
      <div className="focus-prompts nodrag nopan nowheel">
        {userMessages.map((message) => <span key={message.id}>{message.text}</span>)}
      </div>
      <main className="focus-answer nodrag nopan nowheel">
        {!latestAssistant && <EmptyConversation provider={props.provider} />}
        {latestAssistant && <Markdown text={latestAssistant.text} />}
        <ApprovalPanel {...props} />
        <AuthPanel {...props} />
      </main>
      {(props.activities.length > 0 || props.plan.length > 0) && (
        <details className="focus-activity nodrag nopan nowheel" open={props.status === 'working'}>
          <summary>{props.status === 'working' ? 'Working...' : 'Work completed'} - {props.activities.length} actions</summary>
          {props.activities.map((activity) => <ActivityCard activity={activity} key={activity.id} />)}
        </details>
      )}
      <Composer {...props} />
    </div>
  )
}

export default function ChatNode({ id, data, selected }: NodeProps<TerminalCanvasNode>): JSX.Element {
  const variant = useChatPrototypeVariant()
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [activitiesById, setActivitiesById] = useState<Record<string, AgentActivity>>({})
  const [plan, setPlan] = useState<AgentPlanEntry[]>([])
  const [approval, setApproval] = useState<ApprovalState | null>(null)
  const [authMethods, setAuthMethods] = useState<AgentAuthMethod[]>([])
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
      className={`terminal-node chat-node ${selected ? 'selected' : ''} variant-${variant.toLocaleLowerCase()}`}
      style={{ '--node-accent': provider === 'claude' ? '#e69a71' : '#71a9ff', '--project-color': data.projectColor } as React.CSSProperties}
    >
      <NodeResizer minWidth={420} minHeight={320} isVisible={selected} color={data.projectColor} />
      <header className="node-header chat-node-header">
        <span className="status-dot" data-status={status} />
        <strong>{data.label}</strong>
        <span className="node-project" title={data.projectPath}><span className="project-color-dot" />{data.projectName}</span>
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
          {variant === 'A' && <VariantA {...props} />}
          {variant === 'B' && <VariantB {...props} />}
          {variant === 'C' && <VariantC {...props} />}
          {detail && <div className="chat-detail" title={detail}>{detail}</div>}
        </>
      )}
    </article>
  )
}

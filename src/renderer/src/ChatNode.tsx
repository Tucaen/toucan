import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { type NodeProps } from '@xyflow/react'
import ReactMarkdown from 'react-markdown'
import type {
  AgentActivity,
  AgentAuthMethod,
  AgentPlanEntry
} from '../../shared/agent'
import { activityTitle } from '../../shared/agent-activity'
import type { TerminalCanvasNode, TerminalNodeStatus } from './canvas-workspace'
import NodeBorderResizer from './NodeBorderResizer'
import VoiceInputPrototype from './VoiceInputPrototype'
import {
  useAgentConversation,
  type AgentApprovalState,
  type AgentChatMessage,
  type AgentChatStatus
} from './use-agent-conversation'

export interface ChatViewProps {
  provider: 'claude' | 'codex'
  messages: AgentChatMessage[]
  activities: AgentActivity[]
  plan: AgentPlanEntry[]
  approval: AgentApprovalState | null
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

interface PickerOption {
  id: string
  name: string
  description?: string
}

const pickerCopy = {
  permission: { icon: '*', heading: 'Permission mode', idle: 'Permissions', hint: 'Set the permission mode for this agent' },
  model: { icon: '#', heading: 'Model', idle: 'Model', hint: 'Choose the model for this conversation' }
} as const

/** One dropdown shape for every agent-reported selector, so modes and models stay consistent. */
export function SelectorPicker(props: {
  kind: keyof typeof pickerCopy
  options: PickerOption[]
  selectedId?: string
  disabled: boolean
  select(optionId: string): void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const copy = pickerCopy[props.kind]
  const selected = props.options.find((option) => option.id === props.selectedId)
  const canOpen = props.options.length > 0 && !props.disabled

  return (
    <div
      className="node-picker nodrag"
      data-picker={props.kind}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false)
      }}
      onClick={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        className="node-picker-button"
        aria-expanded={open}
        aria-haspopup="listbox"
        disabled={!canOpen}
        title={selected?.description ?? selected?.name ?? copy.hint}
        onClick={() => setOpen((current) => !current)}
      >
        <span aria-hidden="true">{copy.icon}</span>
        {selected?.name ?? copy.idle}
        <span aria-hidden="true">⌄</span>
      </button>
      {open && (
        <div className="node-picker-menu" role="listbox" aria-label={copy.heading}>
          <small>{copy.heading}</small>
          {props.options.map((option) => (
            <button
              type="button"
              role="option"
              aria-selected={option.id === props.selectedId}
              data-selected={option.id === props.selectedId}
              key={option.id}
              onClick={() => {
                props.select(option.id)
                setOpen(false)
              }}
            >
              <strong>{option.name}</strong>
              {option.description && <span>{option.description}</span>}
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
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const composerDisabled = busy || props.status === 'starting' || props.status === 'auth_required'
  return (
    <form className="chat-composer nodrag" onSubmit={props.submit}>
      <textarea
        ref={textareaRef}
        value={props.draft}
        onChange={(event) => props.setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault()
            event.currentTarget.form?.requestSubmit()
          }
        }}
        placeholder={busy ? 'Agent is working...' : 'Message the agent...'}
        disabled={composerDisabled}
      />
      <VoiceInputPrototype
        draft={props.draft}
        disabled={composerDisabled || props.status === 'exited'}
        textareaRef={textareaRef}
        setDraft={props.setDraft}
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

export function ChatView(props: ChatViewProps & {
  worklogCollapsed: boolean
  setWorklogCollapsed(collapsed: boolean): void
  empty?: { icon: string; title: string; description: string }
  statusBar?: ReactNode
}): JSX.Element {
  const workItemCount = props.activities.length + props.plan.length
  return (
    <div className={`agent-chat ${props.worklogCollapsed ? 'worklog-collapsed' : ''} ${props.statusBar ? 'has-status-bar' : ''}`}>
      <div className="chat-scroll nodrag nopan nowheel">
        {props.messages.length === 0 && (props.empty
          ? (
            <div className="chat-empty">
              <span>{props.empty.icon}</span>
              <strong>{props.empty.title}</strong>
              <p>{props.empty.description}</p>
            </div>
          )
          : <EmptyConversation provider={props.provider} />)}
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
      {props.statusBar && <div className="agent-chat-status-bar">{props.statusBar}</div>}
      <Composer {...props} />
    </div>
  )
}

/** The sidebar only cares whether the agent is busy, blocked, or waiting on us. */
function sidebarStatus(status: AgentChatStatus, awaitingApproval: boolean, unreadResult: boolean): TerminalNodeStatus {
  if (status === 'exited') return 'exited'
  if (status === 'auth_required' || awaitingApproval) return 'attention'
  if (status === 'starting') return 'starting'
  if (status === 'working') return 'working'
  return unreadResult ? 'result' : 'idle'
}

export default function ChatNode({ id, data, selected }: NodeProps<TerminalCanvasNode>): JSX.Element {
  const [unreadResult, setUnreadResult] = useState(false)
  const previousStatusRef = useRef<AgentChatStatus>('starting')
  const provider = data.kind === 'claude' ? 'claude' : 'codex'
  const conversation = useAgentConversation({
    id,
    provider,
    cwd: data.projectPath,
    sessionId: data.launchMode === 'resume' ? data.conversationId : undefined,
    permissionMode: data.preferredPermissionMode,
    modelId: data.modelId,
    enabled: !data.dormant,
    onSessionId: (sessionId) => data.onConversationId(id, sessionId),
    onPermissionMode: (modeId) => data.onPermissionModeChange(provider, modeId),
    onModel: (modelId) => data.onModelChange(id, modelId)
  })
  const { status, approval, models, modes, detail } = conversation

  // A finished turn stays flagged as an unread result until the node is focused.
  useEffect(() => {
    const finishedTurn = previousStatusRef.current === 'working' && status === 'ready'
    previousStatusRef.current = status
    if (finishedTurn && !selected) setUnreadResult(true)
  }, [selected, status])

  useEffect(() => {
    if (selected || status === 'working') setUnreadResult(false)
  }, [selected, status])

  useEffect(() => {
    if (data.dormant) return
    data.onStatusChange(id, sidebarStatus(status, approval !== null, unreadResult))
  }, [approval, data.dormant, data.onStatusChange, id, status, unreadResult])

  const props: ChatViewProps = {
    provider,
    ...conversation
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
          <>
            <SelectorPicker
              kind="model"
              options={models?.availableModels ?? []}
              selectedId={models?.currentModelId}
              disabled={conversation.selectorsDisabled}
              select={conversation.selectModel}
            />
            <SelectorPicker
              kind="permission"
              options={modes?.availableModes ?? []}
              selectedId={modes?.currentModeId}
              disabled={conversation.selectorsDisabled}
              select={conversation.selectMode}
            />
          </>
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

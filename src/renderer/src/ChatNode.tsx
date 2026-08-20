import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { type NodeProps } from '@xyflow/react'
import ReactMarkdown from 'react-markdown'
import type {
  AgentActivity,
  AgentAuthMethod,
  AgentPlanEntry
} from '../../shared/agent'
import { activityTitle } from '../../shared/agent-activity'
import { QuotaStat, UsageStat } from './AgentUsageStatus'
import { isNearScrollBottom } from './chat-scroll-follow'
import type { TerminalCanvasNode, TerminalNodeStatus } from './canvas-workspace'
import { computeNodePickerMenuPosition } from './node-picker-menu-position'
import { imageFilesFromClipboard, type AgentImageAttachment } from './image-attachment'
import NodeBorderResizer from './NodeBorderResizer'
import { useFirstMateQuota } from './use-firstmate-quota'
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
  authLink: string | null
  reauthenticating: boolean
  status: string
  detail?: string
  draft: string
  imageSupport: boolean
  attachments: AgentImageAttachment[]
  setDraft(value: string): void
  addImages(files: File[] | FileList): Promise<void>
  removeAttachment(id: string): void
  submit(event: FormEvent): void
  cancel(): void
  authenticate(methodId: string): void
  openAuthLink(url: string): void
  resolveApproval(approvalId: string, optionId?: string): void
}

const providerNames = { claude: 'Claude', codex: 'Codex' } as const

// A 'working' session with no new message/activity/plan event for this long is flagged
// as stalled. Long enough that a slow tool call (build, long shell command) doesn't
// false-positive, short enough to catch a genuinely wedged agent.
const STALL_THRESHOLD_MS = 5 * 60 * 1000
const STALL_CHECK_INTERVAL_MS = 15 * 1000

interface PickerOption {
  id: string
  name: string
  description?: string
}

const pickerCopy = {
  provider: { icon: '@', heading: 'Provider', idle: 'Provider', hint: 'Choose the agent provider' },
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
  const [menuPosition, setMenuPosition] = useState<{ top: number; left: number } | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const copy = pickerCopy[props.kind]
  const selected = props.options.find((option) => option.id === props.selectedId)
  const canOpen = props.options.length > 0 && !props.disabled

  // The menu portals to <body> so it can escape ancestors (e.g. the FirstMate
  // panel, canvas nodes) that clip overflow; position it against the trigger
  // button's viewport rect instead of relying on CSS anchoring.
  useLayoutEffect(() => {
    if (!open) {
      setMenuPosition(null)
      return
    }
    const reposition = (): void => {
      const trigger = buttonRef.current?.getBoundingClientRect()
      const menu = menuRef.current?.getBoundingClientRect()
      if (!trigger) return
      setMenuPosition(computeNodePickerMenuPosition(
        trigger,
        { width: menu?.width ?? 230, height: menu?.height ?? 0 },
        { width: window.innerWidth, height: window.innerHeight }
      ))
    }
    reposition()
    window.addEventListener('resize', reposition)
    window.addEventListener('scroll', reposition, true)
    return () => {
      window.removeEventListener('resize', reposition)
      window.removeEventListener('scroll', reposition, true)
    }
  }, [open, props.options])

  const closeUnlessFocusStaysInside = (relatedTarget: EventTarget | null): void => {
    const next = relatedTarget as Node | null
    if (containerRef.current?.contains(next) || menuRef.current?.contains(next)) return
    setOpen(false)
  }

  const menu = open && (
    <div
      ref={menuRef}
      className="node-picker-menu"
      role="listbox"
      aria-label={copy.heading}
      style={{
        position: 'fixed',
        top: menuPosition?.top ?? 0,
        left: menuPosition?.left ?? 0,
        visibility: menuPosition ? 'visible' : 'hidden'
      }}
      onBlur={(event) => closeUnlessFocusStaysInside(event.relatedTarget)}
      onClick={(event) => event.stopPropagation()}
    >
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
  )

  return (
    <div
      ref={containerRef}
      className="node-picker nodrag"
      data-picker={props.kind}
      onBlur={(event) => closeUnlessFocusStaysInside(event.relatedTarget)}
      onClick={(event) => event.stopPropagation()}
    >
      <button
        ref={buttonRef}
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
      {menu && createPortal(menu, document.body)}
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

function AttachmentPreview(
  props: { attachments: AgentImageAttachment[]; removeAttachment(id: string): void }
): JSX.Element | null {
  if (props.attachments.length === 0) return null
  return (
    <div className="composer-attachments">
      {props.attachments.map((attachment) => (
        <div className="composer-attachment" key={attachment.id}>
          <img src={`data:${attachment.mimeType};base64,${attachment.data}`} alt="Pasted attachment" />
          <button
            type="button"
            className="composer-attachment-remove"
            aria-label="Remove attached image"
            onClick={() => props.removeAttachment(attachment.id)}
          >
            {'×'}
          </button>
        </div>
      ))}
    </div>
  )
}

function Composer(props: Pick<ChatViewProps,
  'draft' | 'setDraft' | 'submit' | 'cancel' | 'status' | 'imageSupport' | 'attachments' | 'addImages' | 'removeAttachment'
>): JSX.Element {
  const busy = props.status === 'working'
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const composerDisabled = props.status === 'starting' || props.status === 'auth_required' || props.status === 'exited'
  const [pasteBlocked, setPasteBlocked] = useState(false)

  const handlePaste = (event: React.ClipboardEvent<HTMLTextAreaElement>): void => {
    const files = imageFilesFromClipboard(event.clipboardData?.items)
    if (files.length === 0) return
    event.preventDefault()
    if (!props.imageSupport) {
      setPasteBlocked(true)
      return
    }
    setPasteBlocked(false)
    void props.addImages(files)
  }

  return (
    <form className="chat-composer nodrag" onSubmit={props.submit}>
      <AttachmentPreview attachments={props.attachments} removeAttachment={props.removeAttachment} />
      {pasteBlocked && (
        <small className="composer-paste-blocked">This agent doesn't support image attachments.</small>
      )}
      <div className="chat-composer-row">
        <textarea
          ref={textareaRef}
          value={props.draft}
          onChange={(event) => {
            props.setDraft(event.target.value)
            setPasteBlocked(false)
          }}
          onPaste={handlePaste}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              event.currentTarget.form?.requestSubmit()
            }
          }}
          placeholder={busy ? 'Agent is working... your message will be queued' : 'Message the agent...'}
          disabled={composerDisabled}
        />
        <VoiceInputPrototype
          draft={props.draft}
          disabled={composerDisabled}
          textareaRef={textareaRef}
          setDraft={props.setDraft}
        />
        {busy && <button type="button" className="stop-agent" onClick={props.cancel}>Stop</button>}
        <button type="submit" disabled={(!props.draft.trim() && props.attachments.length === 0) || composerDisabled}>
          {busy ? 'Queue' : 'Send'}
        </button>
      </div>
    </form>
  )
}

function AuthPanel(
  props: Pick<ChatViewProps, 'provider' | 'authMethods' | 'authLink' | 'authenticate' | 'openAuthLink'>
): JSX.Element {
  // Even with no auth methods to offer (shouldn't happen, but silently rendering nothing would
  // strand the user with only the transient error text below the composer and no visible
  // affordance at all), keep the panel itself always present while auth is required.
  if (props.authMethods.length === 0) {
    return (
      <section className="chat-auth-panel">
        <span className="auth-lock">*</span>
        <div>
          <strong>Sign in to {providerNames[props.provider]}</strong>
          <p>No sign-in method is available for this session. Restart the conversation to try again.</p>
        </div>
      </section>
    )
  }
  const subscriptionMethods = props.authMethods.filter((method) => (
    method.name.toLocaleLowerCase().includes('chatgpt')
    || method.name.toLocaleLowerCase().includes('subscription')
    || method.name.toLocaleLowerCase().includes('claude')
  ))
  const method = subscriptionMethods[0] ?? props.authMethods[0]
  return (
    <section className="chat-auth-panel">
      <span className="auth-lock">*</span>
      <div>
        <strong>Sign in to {providerNames[props.provider]}</strong>
        <p>Connect your existing subscription to enable messages and voice input.</p>
        <button type="button" onClick={() => props.authenticate(method.id)}>
          {method.name}
        </button>
        {props.authLink && (
          <p className="auth-link">
            Waiting for you to finish signing in.{' '}
            <button type="button" className="auth-link-button" onClick={() => props.openAuthLink(props.authLink!)}>
              Open the sign-in link again
            </button>
          </p>
        )}
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

/**
 * Keeps the chat scroll container pinned to the bottom on initial load and as new content
 * streams in, but only while the user hasn't deliberately scrolled up to read history - a
 * message arriving shouldn't yank them back down mid-read.
 */
function useStickToBottom(followDeps: readonly unknown[]): {
  ref: RefObject<HTMLDivElement>
  onScroll(): void
} {
  const ref = useRef<HTMLDivElement>(null)
  const stickToBottomRef = useRef(true)

  useLayoutEffect(() => {
    const element = ref.current
    if (element && stickToBottomRef.current) element.scrollTop = element.scrollHeight
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, followDeps)

  return {
    ref,
    onScroll: () => {
      const element = ref.current
      if (element) stickToBottomRef.current = isNearScrollBottom(element)
    }
  }
}

export function ChatView(props: ChatViewProps & {
  worklogCollapsed: boolean
  setWorklogCollapsed(collapsed: boolean): void
  empty?: { icon: string; title: string; description: string }
  statusBar?: ReactNode
}): JSX.Element {
  const workItemCount = props.activities.length + props.plan.length
  const { ref: scrollRef, onScroll } = useStickToBottom([props.messages, props.approval, props.status])
  return (
    <div className={`agent-chat ${props.worklogCollapsed ? 'worklog-collapsed' : ''} ${props.statusBar ? 'has-status-bar' : ''}`}>
      <div className="chat-scroll nodrag nopan nowheel" ref={scrollRef} onScroll={onScroll}>
        {props.status === 'auth_required' || props.reauthenticating
          ? <AuthPanel {...props} />
          : props.messages.length === 0 && (props.empty
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
            <article className={`chat-message ${message.role}${message.queued ? ' queued' : ''}`} key={message.id}>
              <div>
                <Markdown text={message.text} />
                {message.queued && <small className="queued-badge">Queued — will send once the agent is free</small>}
              </div>
            </article>
          ))}
        <ApprovalPanel {...props} />
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

/** The sidebar only cares whether the agent is busy, blocked, waiting on us, or stuck. */
function sidebarStatus(
  status: AgentChatStatus,
  awaitingApproval: boolean,
  unreadResult: boolean,
  stalled: boolean
): TerminalNodeStatus {
  if (status === 'exited') return 'exited'
  if (status === 'auth_required' || awaitingApproval) return 'attention'
  if (status === 'starting') return 'starting'
  if (status === 'working') return stalled ? 'stalled' : 'working'
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
  const { status, approval, models, modes, detail, messages, activities, plan, usage } = conversation
  const quota = useFirstMateQuota(provider, !data.dormant)
  const [stalled, setStalled] = useState(false)
  const lastProgressAtRef = useRef(Date.now())

  // A finished turn stays flagged as an unread result until the node is focused.
  useEffect(() => {
    const finishedTurn = previousStatusRef.current === 'working' && status === 'ready'
    previousStatusRef.current = status
    if (finishedTurn && !selected) setUnreadResult(true)
  }, [selected, status])

  useEffect(() => {
    if (selected || status === 'working') setUnreadResult(false)
  }, [selected, status])

  // Any new message text, tool activity, or plan update counts as progress and resets the stall clock.
  useEffect(() => {
    lastProgressAtRef.current = Date.now()
  }, [messages, activities, plan, detail])

  // While working, periodically check whether progress has gone quiet for too long.
  useEffect(() => {
    if (status !== 'working') {
      setStalled(false)
      return
    }
    lastProgressAtRef.current = Date.now()
    setStalled(false)
    const interval = setInterval(() => {
      setStalled(Date.now() - lastProgressAtRef.current > STALL_THRESHOLD_MS)
    }, STALL_CHECK_INTERVAL_MS)
    return () => clearInterval(interval)
  }, [status])

  useEffect(() => {
    if (data.dormant) return
    data.onStatusChange(id, sidebarStatus(status, approval !== null, unreadResult, stalled))
  }, [approval, data.dormant, data.onStatusChange, id, status, unreadResult, stalled])

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
        <span className="status-dot" data-status={status} data-stalled={stalled} title={stalled ? 'No progress for a while — this session may be stuck' : undefined} />
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
        {!data.dormant && (
          <>
            <UsageStat usage={usage} compact />
            <QuotaStat quota={quota} compact />
          </>
        )}
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

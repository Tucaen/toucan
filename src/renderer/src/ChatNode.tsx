import {
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
  type RefObject
} from 'react'
import { createPortal } from 'react-dom'
import { type NodeProps } from '@xyflow/react'
import {
  AtSign,
  BrainCircuit,
  Check,
  ChevronDown,
  CircleAlert,
  Cpu,
  Keyboard,
  ListChecks,
  ListPlus,
  LockKeyhole,
  Pencil,
  SendHorizontal,
  ShieldCheck,
  Square,
  X
} from 'lucide-react'
import MarkdownMessage from './MarkdownMessage'
import { ImageAttachments } from './ImageAttachments'
import WorktreeBadge from './WorktreeBadge'
import {
  type AgentActivity,
  type AgentAuthMethod,
  type AgentCommand,
  type AgentDecisionRequest,
  type AgentDecisionResponseContent,
  type AgentEffortState,
  type AgentModeState,
  type AgentModelState,
  type AgentPlanEntry,
  type AgentTurnOutcome
} from '../../shared/agent'
import { isNearScrollBottom } from './chat-scroll-follow'
import FindBar, { useMutationContentKey } from './FindBar'
import { useNodeSearchRequest } from './node-search-context'
import {
  formatToolDuration,
  resolveToolCardExpanded,
  toolCardElapsed,
  toolCardIsTiming,
  toolCardStatusLabel,
  type ToolCardChoice
} from './tool-card'
import { TOOL_CARD_LINE_BUDGET, toolCardFamilyFor } from './tool-card-families'
import { FileOperationBody, fileOperationCard } from './FileOperationCard'
import { ShellLaunchesContext } from './ShellExecutionCard'
import { indexShellLaunches } from './shell-execution'
import { SessionCommandsContext } from './skill-invocation'
import { SubagentActivitiesContext, indexSubagentActivities } from './subagent-task'
import { worklogActivities } from './worklog-activities'
import { formatReasoningSize, mergeReasoningEntries, reasoningTailLine, type ReasoningBlock } from './reasoning-blocks'
import { WorkspaceRootsContext } from './workspace-root'
import { buildHandoffPrompt, planWorktreeHandoff } from '../../shared/worktree-handoff'
import type { TerminalCanvasNode } from './canvas-workspace'
import NodeFitAction from './NodeFitAction'
import { imageAttachmentSource, imageFilesFromClipboard, type AgentImageAttachment } from './image-attachment'
import { classifyAssistantMessage, decisionQuestions, type DecisionOption } from './decision-message'
import { pendingDecisionsFromMessages, type PendingDecision } from './pending-decisions'
import { usePortalMenuPosition } from './use-portal-menu-position'
import NodeBorderResizer from './NodeBorderResizer'
import UnreadToggle from './UnreadToggle'
import SessionUsageBar from './SessionUsageBar'
import { ProviderRateLimitsContext } from './provider-rate-limits'
import { describeSessionUsage } from './session-usage'
import VoiceInput from './VoiceInput'
import { dictationContext } from './voice-transcript'
import { recentMentionPaths } from './file-mention-completion'
import { composerSendKeyLabels, type ComposerSendKey } from './composer-keys'
import { useComposerSendKey } from './composer-send-key-context'
import { usePromptEditor, type ComposerFileMentions } from './use-prompt-editor'
import PromptTextarea from './PromptTextarea'
import ComposerQueue from './ComposerQueue'
import ChatSessionControls from './ChatSessionControls'
import StructuredDecisionPanel from './StructuredDecisionPanel'
import { useConversationReporting } from './use-conversation-reporting'
import SessionKindIcon from './SessionKindIcon'
import type { QueuedPrompt } from './prompt-outbox'
import {
  agentTranscriptEntryKey,
  useAgentConversation,
  type AgentApprovalState,
  type AgentChatMessage,
  type AgentTranscriptEntry
} from './use-agent-conversation'

interface FlatChatViewProps {
  provider: 'claude' | 'codex'
  messages: AgentChatMessage[]
  activities: AgentActivity[]
  outcomes?: AgentTurnOutcome[]
  transcript?: AgentTranscriptEntry[]
  plan: AgentPlanEntry[]
  approval: AgentApprovalState | null
  decisionRequest?: AgentDecisionRequest | null
  authMethods: AgentAuthMethod[]
  authLink: string | null
  reauthenticating: boolean
  status: string
  detail?: string
  draft: string
  imageSupport: boolean
  attachments: AgentImageAttachment[]
  /** Follow-ups still held in the renderer while a turn runs; see prompt-outbox.ts. */
  queued: QueuedPrompt[]
  /**
   * The slash commands and skills the connected session advertises over ACP. Optional because a
   * chat view renders perfectly well before an agent has published any - the completion simply
   * has nothing to offer until then.
   */
  commands?: AgentCommand[]
  /**
   * Where the composer's `@` picker reads its files from. Optional because a chat view renders
   * perfectly well without one - the completion simply has nothing to offer.
   */
  fileMentions?: ComposerFileMentions
  /**
   * The directories tool cards shorten absolute paths against: the one the agent runs in (the
   * worktree when the node has one) and the project checkout. A path under none of them keeps
   * its full form rather than a relative one that would point at the wrong tree.
   */
  workspaceRoots?: readonly string[]
  setDraft(value: string): void
  addImages(files: File[] | FileList): Promise<void>
  removeAttachment(id: string): void
  submit(event: FormEvent, draftOverride?: string, onPrepared?: () => void): void
  sendMessage(text: string): void
  answerDecision(decisionId: string, text: string): void
  editQueued(id: string, text: string): void
  withdrawQueued(id: string): void
  sendQueuedNow(id: string): void
  cancel(): void
  authenticate(methodId: string): void
  submitAuthCode(code: string): Promise<boolean>
  openAuthLink(url: string): void
  resolveApproval(approvalId: string, optionId?: string): void
  resolveElicitation?(requestId: string, content?: AgentDecisionResponseContent): void
  /** Persists the unsent draft; debounced by the prompt editor, so it costs one write per pause. */
  onDraftChange?(draft: string): void
  // The agent-reported selectors, rendered as the composer's toolbar. Optional because a chat
  // view is perfectly renderable before (or without) an adapter reporting any of them.
  modes?: AgentModeState | null
  models?: AgentModelState | null
  efforts?: AgentEffortState | null
  selectorsDisabled?: boolean
  selectMode?(modeId: string): unknown
  selectModel?(modelId: string): void
  selectEffort?(effortId: string): void
}

export type ChatTranscriptProps = Pick<
  FlatChatViewProps,
  'provider' | 'messages' | 'activities' | 'outcomes' | 'transcript' | 'plan' | 'workspaceRoots' | 'commands'
>

export type ChatComposerProps = Pick<
  FlatChatViewProps,
  | 'draft'
  | 'imageSupport'
  | 'attachments'
  | 'queued'
  | 'addImages'
  | 'removeAttachment'
  | 'submit'
  | 'editQueued'
  | 'withdrawQueued'
  | 'sendQueuedNow'
  | 'cancel'
  | 'onDraftChange'
  | 'fileMentions'
  | 'modes'
  | 'models'
  | 'efforts'
  | 'selectorsDisabled'
  | 'selectMode'
  | 'selectModel'
  | 'selectEffort'
>

export type ChatPendingProps = Pick<
  FlatChatViewProps,
  | 'approval'
  | 'decisionRequest'
  | 'resolveApproval'
  | 'resolveElicitation'
  | 'authMethods'
  | 'authLink'
  | 'reauthenticating'
  | 'authenticate'
  | 'submitAuthCode'
  | 'openAuthLink'
  | 'answerDecision'
>

export type ChatSessionControlsProps = Pick<FlatChatViewProps, 'status' | 'detail'> & {
  focusMode: boolean
  setFocusMode(enabled: boolean): void
  focusShortcutEnabled?: boolean
  empty?: { icon: ReactNode; title: string; description: string }
  statusBar?: ReactNode
  completedTaskIds?: ReadonlySet<string>
  closedDecisionIds?: ReadonlySet<string>
}

/**
 * The transcript's find bar, as ChatNode drives it: whether it is open, a signal that re-focuses
 * an already-open bar on a repeated Ctrl+F, and how it closes. Optional because a chat view
 * renders perfectly well without a search - a dormant node's resume panel, for one, has none.
 */
export interface ChatSearchProps {
  open: boolean
  openSignal: number
  label: string
  onClose(): void
}

/** Cohesive boundaries assembled by ChatNode; feature components receive only their own contract. */
export interface ChatViewProps {
  transcript: ChatTranscriptProps
  composer: ChatComposerProps
  pending: ChatPendingProps
  session: ChatSessionControlsProps
  search?: ChatSearchProps
}

const providerNames = { claude: 'Claude', codex: 'Codex' } as const

/** Mirrors `dispatchText`'s guard in use-agent-conversation.ts so a click can't silently no-op. */
function isSendDisabled(status: FlatChatViewProps['status']): boolean {
  return status === 'starting' || status === 'auth_required' || status === 'exited'
}

interface PickerOption {
  id: string
  name: string
  description?: string
}

const pickerCopy = {
  provider: { icon: AtSign, heading: 'Provider', idle: 'Provider', hint: 'Choose the agent provider' },
  permission: {
    icon: ShieldCheck,
    heading: 'Permission mode',
    idle: 'Permissions',
    hint: 'Set the permission mode for this agent'
  },
  model: { icon: Cpu, heading: 'Model', idle: 'Model', hint: 'Choose the model for this conversation' },
  effort: {
    icon: BrainCircuit,
    heading: 'Thinking effort',
    idle: 'Effort',
    hint: 'Set the thinking effort for this conversation'
  },
  sendKey: { icon: Keyboard, heading: 'Send with', idle: 'Send key', hint: 'Choose which key sends a message' }
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
  const containerRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const copy = pickerCopy[props.kind]
  const PickerIcon = copy.icon
  const selected = props.options.find((option) => option.id === props.selectedId)
  const canOpen = props.options.length > 0 && !props.disabled

  // The menu portals to <body> so it can escape ancestors (e.g. canvas nodes) that clip overflow.
  const menuPosition = usePortalMenuPosition(
    buttonRef,
    menuRef,
    open,
    { width: 230, height: 0 },
    undefined,
    props.options
  )

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
          <strong>
            {option.name}
            {option.id === props.selectedId && <Check className="node-picker-selected-marker" aria-hidden="true" />}
          </strong>
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
        <PickerIcon aria-hidden="true" />
        {selected?.name ?? copy.idle}
        <ChevronDown aria-hidden="true" />
      </button>
      {menu && createPortal(menu, document.body)}
    </div>
  )
}

function EmptyConversation({ provider }: Pick<FlatChatViewProps, 'provider'>): JSX.Element {
  return (
    <div className="chat-empty">
      <span>
        <SessionKindIcon kind={provider} />
      </span>
      <strong>Start a conversation</strong>
      <p>Ask {providerNames[provider]} to explore, explain, or change this project.</p>
    </div>
  )
}

function AttachmentPreview(props: {
  attachments: AgentImageAttachment[]
  removeAttachment(id: string): void
}): JSX.Element | null {
  if (props.attachments.length === 0) return null
  return (
    <div className="composer-attachments">
      {props.attachments.map((attachment) => (
        <div className="composer-attachment" key={attachment.id}>
          <img src={imageAttachmentSource(attachment)} alt="Pasted attachment" />
          <button
            type="button"
            className="composer-attachment-remove"
            aria-label="Remove attached image"
            onClick={() => props.removeAttachment(attachment.id)}
          >
            <X aria-hidden="true" />
          </button>
        </div>
      ))}
    </div>
  )
}

/**
 * The composer's own settings row: what the conversation runs as, and how Enter behaves. Grouped
 * into one toolbar rather than scattered across the node header so the pickers read as a set and
 * can wrap together when the node is narrow.
 */
function ComposerToolbar(
  props: Pick<
    FlatChatViewProps,
    'provider' | 'modes' | 'models' | 'efforts' | 'selectorsDisabled' | 'selectMode' | 'selectModel' | 'selectEffort'
  >
): JSX.Element {
  const { sendKey, setSendKey } = useComposerSendKey()
  const disabled = props.selectorsDisabled ?? false
  const ProviderPickerIcon = pickerCopy.provider.icon
  return (
    <div className="composer-toolbar" role="group" aria-label="Conversation settings">
      <span className="composer-toolbar-provider" title={`This conversation runs on ${providerNames[props.provider]}`}>
        <ProviderPickerIcon aria-hidden="true" />
        {providerNames[props.provider]}
      </span>
      {props.models && props.selectModel && (
        <SelectorPicker
          kind="model"
          options={props.models.availableModels}
          selectedId={props.models.currentModelId}
          disabled={disabled}
          select={props.selectModel}
        />
      )}
      {props.efforts && props.selectEffort && (
        <SelectorPicker
          kind="effort"
          options={props.efforts.availableEfforts}
          selectedId={props.efforts.currentEffortId}
          disabled={disabled}
          select={props.selectEffort}
        />
      )}
      {props.modes && props.selectMode && (
        <SelectorPicker
          kind="permission"
          options={props.modes.availableModes}
          selectedId={props.modes.currentModeId}
          disabled={disabled}
          select={props.selectMode}
        />
      )}
      <SelectorPicker
        kind="sendKey"
        options={(Object.keys(composerSendKeyLabels) as ComposerSendKey[]).map((id) => ({
          id,
          ...composerSendKeyLabels[id]
        }))}
        selectedId={sendKey}
        disabled={false}
        select={(id) => setSendKey(id as ComposerSendKey)}
      />
    </div>
  )
}

type ComposerProps = ChatComposerProps &
  Pick<ChatTranscriptProps, 'provider' | 'messages' | 'commands'> &
  Pick<ChatSessionControlsProps, 'status' | 'detail'>

/**
 * Rendering only: the queue chips, the attachment strip, the notices and the footer around one
 * prompt editor. Everything about the text - draft, caret, history, both completion pickers and
 * the keys - belongs to `usePromptEditor`, and `PromptTextarea` renders it.
 */
export function Composer(props: ComposerProps): JSX.Element {
  const busy = props.status === 'working'
  const composerDisabled = isSendDisabled(props.status)
  const { sendKey } = useComposerSendKey()
  // A conversation loaded from disk already shows what was asked; ArrowUp should be able to walk
  // back through it too, rather than starting blank above a full transcript.
  const sentPrompts = useMemo(
    () => props.messages.filter((message) => message.role === 'user').map((message) => message.text),
    [props.messages]
  )
  const editor = usePromptEditor({
    draft: props.draft,
    onDraftChange: props.onDraftChange,
    commands: props.commands ?? [],
    fileMentions: props.fileMentions,
    sentPrompts,
    sendKey,
    disabled: composerDisabled,
    submit: props.submit
  })
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
    <form className="chat-composer nodrag" onSubmit={editor.submit}>
      <ComposerQueue {...props} stranded={composerDisabled} />
      <AttachmentPreview attachments={props.attachments} removeAttachment={props.removeAttachment} />
      {pasteBlocked && <small className="composer-paste-blocked">This agent doesn't support image attachments.</small>}
      {(props.detail || busy) && (
        <div className="composer-notices" role="status" aria-live="polite">
          {props.detail && <small className="composer-status">{props.detail}</small>}
          {busy && <small className="composer-queue-hint">Agent is working... your message will be queued</small>}
        </div>
      )}
      <div className="chat-composer-row">
        <PromptTextarea
          editor={editor}
          placeholder="Message the agent..."
          onPaste={handlePaste}
          onEdit={() => setPasteBlocked(false)}
        />
      </div>
      {/* Dictation, stop, and send sit in the footer rather than beside the textarea: stretched
          alongside a growing input they ballooned with it. */}
      <div className="composer-footer">
        <ComposerToolbar {...props} />
        <div className="composer-actions">
          <VoiceInput
            draft={editor.draft}
            disabled={composerDisabled}
            textareaRef={editor.textareaRef}
            setDraft={editor.setDraft}
            context={dictationContext(editor.draft, props.messages)}
          />
          {busy && (
            <button
              type="button"
              className="stop-agent"
              aria-label="Stop"
              title="Stop the agent"
              onClick={props.cancel}
            >
              <Square aria-hidden="true" />
            </button>
          )}
          <button
            type="submit"
            className="composer-send"
            aria-label={busy ? 'Queue' : 'Send'}
            title={composerSendKeyLabels[sendKey].description}
            disabled={(editor.blank && props.attachments.length === 0) || composerDisabled}
          >
            {busy ? <ListPlus aria-hidden="true" /> : <SendHorizontal aria-hidden="true" />}
          </button>
        </div>
      </div>
    </form>
  )
}
function AuthPanel(
  props: Pick<
    FlatChatViewProps,
    'provider' | 'authMethods' | 'authLink' | 'reauthenticating' | 'authenticate' | 'submitAuthCode' | 'openAuthLink'
  >
): JSX.Element {
  const titleId = useId()
  const descriptionId = useId()
  const codeInputId = useId()
  const [authCode, setAuthCode] = useState('')
  const [submittingCode, setSubmittingCode] = useState(false)
  const [codeError, setCodeError] = useState<string>()
  const dialogProps = {
    className: 'chat-auth-panel nodrag nopan nowheel',
    role: 'dialog',
    'aria-modal': true,
    'aria-labelledby': titleId,
    'aria-describedby': descriptionId
  } as const

  // Even with no auth methods to offer (shouldn't happen, but silently rendering nothing would
  // strand the user with only the transient error text below the composer and no visible
  // affordance at all), keep the panel itself always present while auth is required.
  if (props.authMethods.length === 0) {
    return (
      <section {...dialogProps}>
        <div className="chat-auth-card">
          <LockKeyhole className="auth-lock" aria-hidden="true" />
          <div>
            <strong id={titleId}>Sign in to {providerNames[props.provider]}</strong>
            <p id={descriptionId}>
              No sign-in method is available for this session. Restart the conversation to try again.
            </p>
          </div>
        </div>
      </section>
    )
  }
  const subscriptionMethods = props.authMethods.filter(
    (method) =>
      method.name.toLocaleLowerCase().includes('chatgpt') ||
      method.name.toLocaleLowerCase().includes('subscription') ||
      method.name.toLocaleLowerCase().includes('claude')
  )
  const method = subscriptionMethods[0] ?? props.authMethods[0]
  return (
    <section {...dialogProps}>
      <div className="chat-auth-card">
        <LockKeyhole className="auth-lock" aria-hidden="true" />
        <div>
          <strong id={titleId}>Sign in to {providerNames[props.provider]}</strong>
          <p id={descriptionId}>Connect your existing subscription to enable messages and voice input.</p>
          <button type="button" disabled={props.reauthenticating} onClick={() => props.authenticate(method.id)}>
            {props.reauthenticating ? 'Signing in…' : method.name}
          </button>
          {props.authLink && (
            <>
              <p className="auth-link">
                Finish signing in in your browser.{' '}
                <button type="button" className="auth-link-button" onClick={() => props.openAuthLink(props.authLink!)}>
                  Open the sign-in link again
                </button>
              </p>
              {method.type === 'terminal' && props.reauthenticating && (
                <form
                  className="auth-code-form"
                  onSubmit={(event) => {
                    event.preventDefault()
                    const code = authCode.trim()
                    if (!code || submittingCode) return
                    setCodeError(undefined)
                    setSubmittingCode(true)
                    void props.submitAuthCode(code).then((sent) => {
                      if (sent) setAuthCode('')
                      else setCodeError('Toucan could not send the code. Start sign-in again and retry.')
                      setSubmittingCode(false)
                    })
                  }}
                >
                  <label htmlFor={codeInputId}>Paste the code shown in your browser</label>
                  <small>Only needed if the browser asks you to paste a code back into Toucan.</small>
                  <div>
                    <input
                      id={codeInputId}
                      type="text"
                      autoComplete="one-time-code"
                      spellCheck="false"
                      autoFocus
                      value={authCode}
                      onChange={(event) => setAuthCode(event.target.value)}
                    />
                    <button type="submit" disabled={submittingCode || !authCode.trim()}>
                      {submittingCode ? 'Submitting…' : 'Submit code'}
                    </button>
                  </div>
                  {codeError && (
                    <small className="auth-code-error" role="alert">
                      {codeError}
                    </small>
                  )}
                </form>
              )}
            </>
          )}
        </div>
      </div>
    </section>
  )
}

function ApprovalPanel(props: Pick<FlatChatViewProps, 'approval' | 'resolveApproval'>): JSX.Element | null {
  const [expandedApprovalId, setExpandedApprovalId] = useState<string | null>(null)
  if (!props.approval) return null
  const showAll = expandedApprovalId === props.approval.id
  const diff = props.approval.activity
    ? fileOperationCard(props.approval.activity, showAll ? null : TOOL_CARD_LINE_BUDGET)
    : null
  return (
    <section className="chat-approval-panel">
      <span>Permission requested</span>
      <strong>{props.approval.title}</strong>
      {diff && (
        <div className="chat-approval-diff">
          <FileOperationBody operation={diff.operation} blocks={diff.blocks} />
          {diff.hiddenLines > 0 && (
            <button
              type="button"
              className="activity-show-more"
              onClick={() => setExpandedApprovalId(props.approval!.id)}
            >
              Show {diff.hiddenLines} more lines
            </button>
          )}
          {showAll && (
            <button type="button" className="activity-show-more" onClick={() => setExpandedApprovalId(null)}>
              Show less
            </button>
          )}
        </div>
      )}
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
        <button type="button" onClick={() => props.resolveApproval(props.approval!.id)}>
          Cancel
        </button>
      </div>
    </section>
  )
}

/**
 * Renders a pending decision's extracted options as clickable buttons plus a free-text "Other"
 * field. Both paths reuse the ordinary prompt/steering delivery path with decision identity rather
 * than introducing a protocol-level channel; see pending-decisions.ts for state folding.
 */
function DecisionOptions(props: {
  decisionId?: string
  options: DecisionOption[]
  answerDecision: FlatChatViewProps['answerDecision']
  status: FlatChatViewProps['status']
  submitting?: boolean
}): JSX.Element {
  const [otherText, setOtherText] = useState('')
  const disabled = isSendDisabled(props.status) || props.submitting
  const send = (text: string): void => props.answerDecision(props.decisionId ?? '', text)
  return (
    <div className="decision-options">
      <div className="decision-options-buttons">
        {props.options.map((option) => (
          <button type="button" key={option.id} disabled={disabled} onClick={() => send(option.label)}>
            {option.label}
          </button>
        ))}
      </div>
      <form
        className="decision-options-other"
        onSubmit={(event) => {
          event.preventDefault()
          const text = otherText.trim()
          if (!text) return
          send(text)
          setOtherText('')
        }}
      >
        <input
          type="text"
          placeholder="Other…"
          value={otherText}
          disabled={disabled}
          onChange={(event) => setOtherText(event.target.value)}
        />
        <button type="submit" disabled={disabled || !otherText.trim()}>
          Send
        </button>
      </form>
    </div>
  )
}

/** Wording comes from decisionQuestions (see decision-message.ts). */
function DecisionQuestions(props: { text: string }): JSX.Element {
  const questions = decisionQuestions(props.text)
  if (questions.length > 1)
    return (
      <ol className="decision-questions">
        {questions.map((question, index) => (
          <li key={index}>{question}</li>
        ))}
      </ol>
    )
  return <p>{questions[0] ?? 'Choose an option.'}</p>
}

/** Classifies assistant replies for visual tone (see decision-message.ts). */
function ChatMessageCard(props: { message: AgentChatMessage }): JSX.Element {
  const { message } = props
  const tone = message.role === 'assistant' ? classifyAssistantMessage(message.text) : 'normal'
  const images = message.images ?? []
  return (
    <article
      className={`chat-message ${message.role}${message.queued ? ' queued' : ''}${message.failed ? ' failed' : ''}`}
      data-tone={tone}
      data-presentation={message.presentation}
    >
      <div>
        {message.presentation === 'progress' && <small className="progress-label">Progress</small>}
        {/* An image-only message is the one case that renders no markdown body: `.markdown-body`
            is emitted even for empty text, and an empty one would sit above the thumbnails as
            dead space. Every other message keeps its body, so nothing else's layout moves. */}
        {!(images.length > 0 && !message.text) && (
          <MarkdownMessage text={message.text} authored={message.role === 'user'} />
        )}
        <ImageAttachments images={images} />
        {message.failed ? (
          <small className="failed-badge">Not sent — delivery was rejected</small>
        ) : (
          message.queued && <small className="queued-badge">Queued — will send once the agent is free</small>
        )}
      </div>
    </article>
  )
}

function TurnOutcomeCard({ outcome }: { outcome: AgentTurnOutcome }): JSX.Element {
  const failed = outcome.status === 'failed'
  return (
    <article className="turn-outcome" data-status={outcome.status} role={failed ? 'alert' : 'status'}>
      <strong>{failed ? 'Turn failed' : 'Turn cancelled'}</strong>
      <MarkdownMessage text={outcome.message} />
    </article>
  )
}

/**
 * Re-renders once a second, but only while something is actually being timed - a rail full of
 * finished cards must not keep a timer alive.
 */
function useElapsedClock(running: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!running) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [running])
  return now
}

/**
 * The shell every tool card sits in. It owns all the chrome - icon, one-line summary, status,
 * elapsed duration, collapse, and the bounded-height body with its "show more" - and delegates
 * only the summary and the body to the activity's family (see `tool-card-families.tsx`), so a
 * per-tool card never re-implements any of this.
 */
function ActivityCard({ activity }: { activity: AgentActivity }): JSX.Element {
  const family = toolCardFamilyFor(activity)
  const [choice, setChoice] = useState<ToolCardChoice | undefined>(undefined)
  const [showAll, setShowAll] = useState(false)
  const expanded = resolveToolCardExpanded(activity.status, choice)
  const now = useElapsedClock(toolCardIsTiming(activity))
  const duration = formatToolDuration(toolCardElapsed(activity, now))
  const body = expanded ? family.body(activity, showAll ? null : TOOL_CARD_LINE_BUDGET) : null
  return (
    <article className="activity-card" data-status={activity.status} data-family={family.id} data-expanded={expanded}>
      <button
        type="button"
        className="activity-header"
        aria-expanded={expanded}
        onClick={() => setChoice({ expanded: !expanded, status: activity.status })}
      >
        <span className="activity-icon">{family.icon(activity)}</span>
        <strong>{family.summary(activity)}</strong>
        {duration && <small className="activity-duration">{duration}</small>}
        <span className="activity-state">{toolCardStatusLabel(activity.status)}</span>
      </button>
      {/* Outside the collapsible body on purpose: a settled card collapses itself, and an image
          the tool produced is the output, not a detail behind a disclosure. Outside the family
          too - any tool may return an image, so the shell owns it rather than each family. */}
      {activity.images && <ImageAttachments images={activity.images} label="Generated image" />}
      {body && (
        <div className="activity-body">
          {body.content}
          {body.hiddenLines > 0 && (
            <button type="button" className="activity-show-more" onClick={() => setShowAll(true)}>
              Show {body.hiddenLines} more lines
            </button>
          )}
          {showAll && (
            <button type="button" className="activity-show-more" onClick={() => setShowAll(false)}>
              Show less
            </button>
          )}
        </div>
      )}
    </article>
  )
}

/**
 * One deliberation, however many thought messages it arrived as. Expansion is owned by `ChatView`
 * rather than by this component: Focus mode unmounts these cards, and local state would forget a
 * block the reader had deliberately opened.
 */
function ReasoningCard({
  block,
  expanded,
  onToggle
}: {
  block: ReasoningBlock
  expanded: boolean
  onToggle(): void
}): JSX.Element {
  const size = formatReasoningSize(block.estimatedTokens)
  // Collapsed, a streaming block would otherwise be indistinguishable from a finished one, so the
  // newest line of reasoning stands in for progress until the block is expanded anyway.
  const preview = block.streaming && !expanded ? reasoningTailLine(block.text) : ''
  // One word for both the visible heading and the accessible name, so a screen reader is never
  // told "Reasoning" while the card reads "Thinking".
  const heading = block.streaming ? 'Thinking' : 'Reasoning'
  return (
    <article
      className="activity-card thought-card"
      data-family="reasoning"
      data-expanded={expanded}
      data-streaming={block.streaming}
    >
      <button
        type="button"
        className="activity-header"
        aria-label={heading}
        aria-expanded={expanded}
        onClick={onToggle}
      >
        <span className="activity-icon">
          <BrainCircuit aria-hidden="true" />
        </span>
        <strong>{heading}</strong>
        {block.chunkIds.length > 1 && <small className="thought-count">{block.chunkIds.length} thoughts</small>}
        {size && <span className="activity-state">{size}</span>}
      </button>
      {preview && <p className="thought-preview">{preview}</p>}
      {expanded && (
        <div className="activity-body">
          <MarkdownMessage text={block.text} />
        </div>
      )}
    </article>
  )
}

function PlanCard({ plan }: { plan: AgentPlanEntry[] }): JSX.Element {
  const [expanded, setExpanded] = useState(true)
  return (
    <article className="activity-card plan-card" data-family="plan" data-expanded={expanded}>
      <button
        type="button"
        className="activity-header"
        aria-expanded={expanded}
        onClick={() => setExpanded((current) => !current)}
      >
        <span className="activity-icon">
          <ListChecks aria-hidden="true" />
        </span>
        <strong>Plan</strong>
        <span className="activity-state">{plan.length} steps</span>
      </button>
      {expanded && (
        <div className="activity-body">
          <ol className="plan-list">
            {plan.map((entry, index) => (
              <li data-status={entry.status} key={`${index}-${entry.content}`}>
                {entry.content}
              </li>
            ))}
          </ol>
        </div>
      )}
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
  }, followDeps)

  return {
    ref,
    onScroll: () => {
      const element = ref.current
      if (element) stickToBottomRef.current = isNearScrollBottom(element)
    }
  }
}

export function ChatView(groups: ChatViewProps): JSX.Element {
  const { transcript, composer, pending, session, search } = groups
  // A subagent's tool calls arrive in the same flat feed as the parent's own; these two say
  // which card each one belongs to. Both are keyed on the ids the adapter reported, never on
  // ordering, so an activity always renders somewhere (see `worklog-activities.ts`).
  const subagentActivities = useMemo(() => indexSubagentActivities(transcript.activities), [transcript.activities])
  const inlineActivities = useMemo(
    () => worklogActivities(transcript.activities, subagentActivities, transcript.plan.length > 0),
    [transcript.activities, subagentActivities, transcript.plan.length]
  )
  const authVisible = session.status === 'auth_required' || pending.reauthenticating
  const pendingDecisions = pendingDecisionsFromMessages(
    transcript.messages,
    session.completedTaskIds,
    session.closedDecisionIds
  )
  const { ref: scrollRef, onScroll } = useStickToBottom([
    transcript.messages,
    transcript.activities,
    transcript.outcomes,
    transcript.plan,
    session.focusMode,
    pending.approval,
    session.status
  ])
  // A BashOutput/KillShell card can only name its command by looking across the whole transcript, so
  // the index is built once here rather than per card. Only a launch's own reported shell id can
  // change it, so it is recomputed only when the activity list itself does.
  const shellLaunches = useMemo(() => indexShellLaunches(transcript.activities), [transcript.activities])
  const rootRef = useRef<HTMLDivElement>(null)
  const searchContentKey = useMutationContentKey(scrollRef, search?.open ?? false)
  const transcriptEntries = useMemo(() => {
    const entries = [
      ...transcript.messages.map((message) => ({
        type: 'message' as const,
        key: agentTranscriptEntryKey({ type: 'message', id: message.id, role: message.role }),
        message
      })),
      ...inlineActivities.map((activity) => ({
        type: 'activity' as const,
        key: agentTranscriptEntryKey({ type: 'activity', id: activity.id }),
        activity
      })),
      ...(transcript.outcomes ?? []).map((outcome) => ({
        type: 'outcome' as const,
        key: agentTranscriptEntryKey({ type: 'outcome', id: outcome.id }),
        outcome
      }))
    ]
    const byKey = new Map(entries.map((entry) => [entry.key, entry]))
    const ordered = (transcript.transcript ?? []).flatMap((entry) => {
      const key = agentTranscriptEntryKey(entry)
      const match = byKey.get(key)
      if (!match) return []
      byKey.delete(key)
      return [match]
    })
    // Merging is a transcript-order concern, not a message-list one: what separates two
    // deliberations is the tool call or the prose that landed between them.
    return mergeReasoningEntries(
      [...ordered, ...byKey.values()],
      (entry) =>
        entry.type === 'message' && entry.message.role === 'thought'
          ? { id: entry.message.id, text: entry.message.text }
          : null,
      { working: session.status === 'working' }
    )
  }, [inlineActivities, session.status, transcript.messages, transcript.outcomes, transcript.transcript])
  // Keyed on a block's id, which is its first chunk's id and so survives the block growing.
  const [expandedReasoning, setExpandedReasoning] = useState<ReadonlySet<string>>(() => new Set())
  const toggleReasoning = useCallback((id: string) => {
    setExpandedReasoning((current) => {
      const next = new Set(current)
      if (!next.delete(id)) next.add(id)
      return next
    })
  }, [])
  return (
    <div
      ref={rootRef}
      className={`agent-chat ${session.focusMode ? 'focus-mode' : ''} ${session.statusBar ? 'has-status-bar' : ''} ${pendingDecisions.length > 0 || pending.decisionRequest ? 'has-pending-decisions' : ''}`}
    >
      <ChatSessionControls
        rootRef={rootRef}
        focusMode={session.focusMode}
        setFocusMode={session.setFocusMode}
        focusShortcutEnabled={session.focusShortcutEnabled}
      />
      {/* The bar searches what the transcript currently renders - a collapsed tool card's hidden
          lines are not in the DOM and are found once the reader expands it, not before. */}
      {search?.open && (
        <FindBar
          containerRef={scrollRef}
          contentKey={searchContentKey}
          openSignal={search.openSignal}
          label={search.label}
          onClose={search.onClose}
        />
      )}
      {/* Tool cards live several components deep and every one of them shortens paths against
          these roots, so they reach the cards as context rather than as a prop chain. */}
      <WorkspaceRootsContext.Provider value={transcript.workspaceRoots ?? []}>
        <ShellLaunchesContext.Provider value={shellLaunches}>
          <SubagentActivitiesContext.Provider value={subagentActivities}>
            <SessionCommandsContext.Provider value={transcript.commands ?? []}>
              <div className="chat-scroll nodrag nopan nowheel" ref={scrollRef} onScroll={onScroll}>
                {!authVisible &&
                  transcript.messages.length === 0 &&
                  (transcript.outcomes?.length ?? 0) === 0 &&
                  (session.empty ? (
                    <div className="chat-empty">
                      <span>{session.empty.icon}</span>
                      <strong>{session.empty.title}</strong>
                      <p>{session.empty.description}</p>
                    </div>
                  ) : (
                    <EmptyConversation provider={transcript.provider} />
                  ))}
                {transcriptEntries.map((item) =>
                  item.kind === 'reasoning' ? (
                    !session.focusMode && (
                      <ReasoningCard
                        key={`reasoning:${item.block.id}`}
                        block={item.block}
                        expanded={expandedReasoning.has(item.block.id)}
                        onToggle={() => toggleReasoning(item.block.id)}
                      />
                    )
                  ) : item.entry.type === 'activity' ? (
                    !session.focusMode && <ActivityCard activity={item.entry.activity} key={item.entry.key} />
                  ) : item.entry.type === 'outcome' ? (
                    <TurnOutcomeCard key={item.entry.key} outcome={item.entry.outcome} />
                  ) : item.entry.message.presentation === 'progress' ? (
                    !session.focusMode && <ChatMessageCard key={item.entry.key} message={item.entry.message} />
                  ) : (
                    <ChatMessageCard key={item.entry.key} message={item.entry.message} />
                  )
                )}
                {!session.focusMode && transcript.plan.length > 0 && <PlanCard plan={transcript.plan} />}
                <ApprovalPanel {...pending} />
              </div>
            </SessionCommandsContext.Provider>
          </SubagentActivitiesContext.Provider>
        </ShellLaunchesContext.Provider>
      </WorkspaceRootsContext.Provider>
      {pendingDecisions.length > 0 && (
        <section className="pending-decisions" aria-label="Pending decisions">
          {pendingDecisions.map((decision: PendingDecision) => (
            <article key={decision.id} data-state={decision.state}>
              <header>
                <strong>Decision needed</strong>
                {decision.taskId && <small>{decision.taskId}</small>}
              </header>
              <DecisionQuestions text={decision.text} />
              <DecisionOptions
                decisionId={decision.id}
                options={decision.options}
                answerDecision={pending.answerDecision}
                status={session.status}
                submitting={decision.state === 'submitting'}
              />
              {decision.state === 'submitting' && <small>Sending your answer…</small>}
            </article>
          ))}
        </section>
      )}
      <StructuredDecisionPanel key={pending.decisionRequest?.id ?? 'no-structured-decision'} {...pending} />
      {session.statusBar && <div className="agent-chat-status-bar">{session.statusBar}</div>}
      {pendingDecisions.length === 0 && !pending.decisionRequest && (
        <Composer
          key={transcript.provider}
          {...composer}
          provider={transcript.provider}
          messages={transcript.messages}
          commands={transcript.commands}
          status={session.status}
          detail={authVisible || (session.focusMode && session.status === 'working') ? undefined : session.detail}
        />
      )}
      {authVisible && <AuthPanel provider={transcript.provider} {...pending} />}
    </div>
  )
}

export default function ChatNode({ id, data, selected }: NodeProps<TerminalCanvasNode>): JSX.Element {
  const provider = data.kind === 'claude' ? 'claude' : 'codex'
  const conversation = useAgentConversation({
    id,
    provider,
    cwd: data.workingDirectory,
    sessionId: data.launchMode === 'resume' ? data.conversationId : undefined,
    permissionMode: data.preferredPermissionMode,
    modelId: data.modelId,
    enabled: !data.dormant,
    onSessionId: (sessionId) => data.onConversationId(id, sessionId),
    onPermissionMode: (modeId) => data.onPermissionModeChange(provider, modeId),
    onModel: (modelId) => data.onModelChange(id, modelId)
  })
  const { status, messages, usage } = conversation
  const [renaming, setRenaming] = useState(false)
  const [titleDraft, setTitleDraft] = useState(data.label)
  const [titleError, setTitleError] = useState(false)
  const outcomes = useMemo(() => {
    const byId = new Map((data.turnOutcomes ?? []).map((outcome) => [outcome.id, outcome]))
    for (const outcome of conversation.outcomes) byId.set(outcome.id, outcome)
    return [...byId.values()]
  }, [conversation.outcomes, data.turnOutcomes])

  // Everything this node reports upward - attention records, sidebar status, the stall verdict,
  // the generated title, persisted outcomes, ticket activity - lives in the reporting hook; the
  // rules themselves are pure functions in conversation-reporting.ts.
  const reporting = useConversationReporting({
    id,
    label: data.label,
    selected: selected ?? false,
    dormant: data.dormant,
    unread: data.unread ?? 0,
    unreadKind: data.unreadKind,
    // The ACP conversation once there is one; until then the node's durable session id, so an
    // early approval or failure is never persisted without any source identity at all.
    sourceId: data.conversationId ?? data.sessionId,
    conversationId: data.conversationId,
    titleSource: data.titleSource,
    persistedOutcomes: data.turnOutcomes,
    conversation,
    onAttention: data.onAttention,
    onStatusChange: data.onStatusChange,
    onTicketActivity: data.onTicketActivity,
    onTurnOutcome: data.onTurnOutcome,
    onTitleChange: data.onTitleChange
  })
  const stalled = reporting.stalled

  const commitTitle = (): void => {
    const title = titleDraft.trim()
    setRenaming(false)
    if (title && title !== data.label) {
      void data.onTitleChange(id, title, 'manual').then((saved) => setTitleError(!saved))
    } else setTitleDraft(data.label)
  }
  // Account usage belongs to the provider, so it arrives from App's single poll rather than from
  // this node asking for it (see provider-rate-limits.ts).
  const rateLimits = useContext(ProviderRateLimitsContext)[provider] ?? null
  // Recomputed only when a turn reports new usage or the account poll returns, never per chunk.
  const usageReadout = useMemo(() => describeSessionUsage({ usage, rateLimits }), [usage, rateLimits])
  /**
   * A prompt asking for its own worktree never runs here. It goes up to the workspace, which
   * starts a session whose working directory is the worktree from its first turn - the only
   * shape in which the worktree can be a writable root rather than an approval prompt. A node
   * already running in a worktree is where such work belongs, so it dispatches normally.
   */
  const submit: FlatChatViewProps['submit'] = (event, draftOverride, onPrepared) => {
    // Mid-turn, the prompt queues as any follow-up does rather than moving a session that is
    // still working. It runs where it was typed when the outbox drains, which is visible in the
    // composer queue - unlike tearing down a session with a turn in flight.
    const handoff = status === 'working' ? undefined : data.onWorktreeHandoff
    const plan = handoff
      ? planWorktreeHandoff(draftOverride ?? data.draft ?? '', {
          hasHistory: messages.length > 0,
          alreadyInWorktree: Boolean(data.worktreeId),
          provider
        })
      : null
    if (!handoff || !plan) {
      conversation.submit(event, draftOverride, onPrepared)
      return
    }
    event.preventDefault()
    // The dialogue is read here because this is where it lives; the workspace only ever sees
    // the finished prompt, never a transcript it would have to go and fetch.
    handoff(id, {
      ...plan,
      prompt: plan.mode === 'handoff' ? buildHandoffPrompt(messages, plan.prompt) : plan.prompt
    })
    data.onDraftChange(id, '')
    onPrepared?.()
  }

  /**
   * A session started to carry a prompt sends it once, as soon as it can. Agent nodes have no
   * shell to write into, so the prompt has to be delivered as a first turn rather than typed.
   */
  // Tracks the value, not merely that one was sent: a node rehomed into a worktree is handed a
  // fresh prompt without ever remounting, so a boolean latch would swallow it.
  const sentInitialInputRef = useRef<string | undefined>(undefined)
  useEffect(() => {
    const pending = data.initialInput
    if (!pending || sentInitialInputRef.current === pending || status !== 'ready') return
    sentInitialInputRef.current = pending
    conversation.sendMessage(pending)
  }, [conversation, data.initialInput, status])

  // Which files the agent has already opened is the only thing the composer knows about what it
  // can see, so it becomes the top band of the `@` picker. Newest first, which for a transcript
  // read front to back means walking the activities backwards.
  const mentionRecent = useMemo(
    () =>
      recentMentionPaths(
        [...conversation.activities].reverse().flatMap((activity) => activity.locations ?? []),
        data.workingDirectory
      ),
    [conversation.activities, data.workingDirectory]
  )
  const fileMentions = useMemo(
    (): ComposerFileMentions => ({
      root: data.workingDirectory,
      recent: mentionRecent,
      read: (root) => window.workspaceFilesApi.index(root)
    }),
    [data.workingDirectory, mentionRecent]
  )

  const [findBar, setFindBar] = useState<{ open: boolean; signal: number }>({ open: false, signal: 0 })
  const dormant = data.dormant
  useNodeSearchRequest(
    id,
    useCallback(() => {
      if (dormant) return
      setFindBar((current) => ({ open: true, signal: current.signal + 1 }))
    }, [dormant])
  )
  const closeFindBar = useCallback((): void => setFindBar((current) => ({ ...current, open: false })), [])

  const flatProps: FlatChatViewProps = {
    provider,
    fileMentions,
    ...conversation,
    outcomes,
    submit,
    // The draft belongs to the node, not to the conversation: it has to outlive resize, collapse
    // and a workspace reload, none of which the ACP session knows anything about.
    draft: data.draft ?? '',
    // The directory the agent was launched in (its worktree, or the checkout) plus the project
    // checkout itself, so a worktree session still shortens a path it read from the main tree.
    // Display only - `workingDirectory` remains the sole value that may be sent as a cwd.
    workspaceRoots: [data.workingDirectory, data.projectPath].filter((root): root is string => !!root),
    onDraftChange: (text) => data.onDraftChange(id, text)
  }

  return (
    <article
      className={`terminal-node chat-node ${selected ? 'selected' : ''}`}
      style={
        {
          '--node-accent': provider === 'claude' ? '#e69a71' : '#71a9ff',
          '--project-color': data.projectColor
        } as React.CSSProperties
      }
    >
      <NodeBorderResizer minWidth={420} minHeight={320} selected={selected} color={data.projectColor} />
      <header className="node-header chat-node-header">
        <span
          className="status-dot"
          data-status={status}
          data-stalled={stalled}
          title={stalled ? 'No progress for a while — this session may be stuck' : undefined}
        />
        {renaming ? (
          <input
            className="node-title-input nodrag"
            aria-label="Conversation title"
            autoFocus
            value={titleDraft}
            onChange={(event) => setTitleDraft(event.target.value)}
            onBlur={commitTitle}
            onKeyDown={(event) => {
              if (event.key === 'Enter') commitTitle()
              if (event.key === 'Escape') {
                setTitleDraft(data.label)
                setRenaming(false)
              }
            }}
          />
        ) : (
          <strong title="Automatic titles are generated locally and cost no model tokens or account budget.">
            {data.label}
          </strong>
        )}
        <button
          type="button"
          className="node-title-rename nodrag"
          aria-label="Rename conversation"
          title="Rename conversation (manual names override automatic titles)"
          onClick={() => {
            setTitleDraft(data.label)
            setRenaming(true)
          }}
        >
          <Pencil aria-hidden="true" />
        </button>
        {(titleError || reporting.generatedTitleError) && (
          <CircleAlert
            className="node-title-error"
            role="alert"
            aria-label="The conversation title could not be saved."
          />
        )}
        <span className="node-project" title={data.projectPath}>
          <span className="project-color-dot" />
          {data.projectName}
        </span>
        <WorktreeBadge data={data} />
        {/* Model, effort and permission pickers live in the composer's toolbar - see
            ComposerToolbar - so the whole picker row reads as one set and the header keeps its
            room for the node's identity. */}
        <UnreadToggle unread={data.unread ?? 0} onToggle={reporting.toggleUnread} />
        <span className="node-status">{status.replace('_', ' ')}</span>
        <NodeFitAction nodeId={id} fitted={data.fittedToCanvas ?? false} />
      </header>
      {data.dormant ? (
        <div className="dormant-session chat-dormant nodrag">
          <span className="dormant-session-icon">
            <SessionKindIcon kind={provider} />
          </span>
          <strong>Saved {providerNames[provider]} conversation</strong>
          <small>
            {data.conversationId
              ? 'Load its ACP history and continue where you left off.'
              : 'Start a new ACP conversation.'}
          </small>
          {data.preview?.assistant && <blockquote>{data.preview.assistant}</blockquote>}
          <button type="button" className="resume-session" onClick={() => data.onResume(id)}>
            {data.conversationId ? 'Open conversation' : 'Start conversation'}
          </button>
        </div>
      ) : (
        <>
          <ChatView
            transcript={{
              provider: flatProps.provider,
              messages: flatProps.messages,
              activities: flatProps.activities,
              outcomes: flatProps.outcomes,
              transcript: flatProps.transcript,
              plan: flatProps.plan,
              workspaceRoots: flatProps.workspaceRoots,
              commands: flatProps.commands
            }}
            composer={flatProps}
            pending={flatProps}
            session={{
              status: flatProps.status,
              detail: flatProps.detail,
              focusMode: data.focusMode,
              setFocusMode: (enabled) => data.onFocusModeChange(id, enabled),
              focusShortcutEnabled: selected,
              statusBar: usageReadout.empty ? undefined : <SessionUsageBar readout={usageReadout} />
            }}
            search={{
              open: findBar.open,
              openSignal: findBar.signal,
              label: `Find in ${data.label}`,
              onClose: closeFindBar
            }}
          />
        </>
      )}
    </article>
  )
}

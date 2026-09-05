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
  isFinalAssistantMessage,
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
import { recentlyWrittenPaths } from './ticket-activity'
import { formatReasoningSize, mergeReasoningEntries, reasoningTailLine, type ReasoningBlock } from './reasoning-blocks'
import { WorkspaceRootsContext } from './workspace-root'
import { buildHandoffPrompt, planWorktreeHandoff } from '../../shared/worktree-handoff'
import type { TerminalCanvasNode, TerminalNodeStatus } from './canvas-workspace'
import NodeFitAction from './NodeFitAction'
import { attentionTextKey, READ_ON_VIEW_KINDS, type AttentionKind } from '../../shared/attention'
import { imageAttachmentSource, imageFilesFromClipboard, type AgentImageAttachment } from './image-attachment'
import { classifyAssistantMessage, decisionQuestions, type DecisionOption } from './decision-message'
import { pendingDecisionsFromMessages, type PendingDecision } from './pending-decisions'
import { usePortalMenuPosition } from './use-portal-menu-position'
import NodeBorderResizer from './NodeBorderResizer'
import UnreadToggle from './UnreadToggle'
import SessionUsageBar from './SessionUsageBar'
import { ProviderRateLimitsContext } from './provider-rate-limits'
import { describeSessionUsage } from './session-usage'
import { deriveConversationTitle } from '../../shared/conversation-title'
import VoiceInputPrototype from './VoiceInputPrototype'
import { composerConsumesWheel, composerTextareaSize } from './composer-autosize'
import {
  acceptSlashCommand,
  acceptedSlashCompletion,
  dismissSlashCompletion,
  emptySlashCompletion,
  highlightSlashCommand,
  moveSlashSelection,
  slashCompletionView
} from './slash-command-completion'
import {
  acceptFileMention,
  acceptedFileMention,
  dismissFileMentionCompletion,
  emptyFileMentionCompletion,
  fileMentionCompletionView,
  fileMentionExclusionNote,
  fileMentionQuery,
  highlightFileMention,
  recentMentionPaths
} from './file-mention-completion'
import type { WorkspaceFileEntry, WorkspaceFileIndex } from '../../shared/workspace-files'
import { composerKeyAction, composerSendKeyLabels, type ComposerSendKey } from './composer-keys'
import { useComposerSendKey } from './composer-send-key-context'
import {
  emptyPromptHistory,
  leaveHistory,
  recallNext,
  recallPrevious,
  rememberPrompt,
  seedPromptHistory
} from './prompt-history'
import ComposerQueue from './ComposerQueue'
import ChatSessionControls from './ChatSessionControls'
import SessionKindIcon from './SessionKindIcon'
import type { QueuedPrompt } from './prompt-outbox'
import {
  agentTranscriptEntryKey,
  useAgentConversation,
  type AgentApprovalState,
  type AgentChatMessage,
  type AgentChatStatus,
  type AgentTranscriptEntry
} from './use-agent-conversation'

/**
 * What the composer needs to complete a file reference. `root` is the node's resolved
 * `workingDirectory` - the worktree when the node is attached to one, never the display-only
 * `projectPath` - because that is the directory the agent will resolve the inserted reference
 * against. `read` is asked only once a mention token actually appears, so a node that never types
 * an `@` never costs a directory listing.
 */
export interface ComposerFileMentions {
  root: string
  /** Root-relative paths this conversation's agent has already touched, newest first. */
  recent: readonly string[]
  read(root: string): Promise<WorkspaceFileIndex>
}

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
  /** Persists the unsent draft; debounced by the Composer, so it costs one write per pause. */
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

/** Cohesive boundaries assembled by ChatNode; feature components receive only their own contract. */
export interface ChatViewProps {
  transcript: ChatTranscriptProps
  composer: ChatComposerProps
  pending: ChatPendingProps
  session: ChatSessionControlsProps
}

const providerNames = { claude: 'Claude', codex: 'Codex' } as const

/** Mirrors `dispatchText`'s guard in use-agent-conversation.ts so a click can't silently no-op. */
function isSendDisabled(status: FlatChatViewProps['status']): boolean {
  return status === 'starting' || status === 'auth_required' || status === 'exited'
}

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

interface CompletionOption {
  key: string
  /** The token the option inserts, shown as the row's own name. */
  label: string
  /** Whatever qualifies the token: a command's argument hint, a folder marker. */
  hint?: string
  description?: string
}

/**
 * The composer's completion list, shared by the slash-command and `@`-mention pickers. Like
 * `SelectorPicker` it portals to `<body>` and positions itself in JS against its anchor's
 * viewport rect - `.terminal-node` clips overflow, so a CSS-anchored menu would be cut off the
 * moment the node sits near a canvas edge. It opens above the composer by preference, since the
 * composer already sits at the bottom of its node.
 */
function CompletionMenu(props: {
  anchorRef: RefObject<HTMLElement>
  id: string
  className: string
  label: string
  options: CompletionOption[]
  activeIndex: number
  optionId(index: number): string
  accept(index: number): void
  highlight(index: number): void
  /** Says what the list is not showing; rendered below the rows, outside the listbox rows. */
  note?: string | null
}): JSX.Element | null {
  const menuRef = useRef<HTMLDivElement>(null)
  const position = usePortalMenuPosition(
    props.anchorRef,
    menuRef,
    true,
    { width: 320, height: 0 },
    { align: 'start', prefer: 'above' },
    props.options
  )

  // The active row has to stay visible while the arrows walk past the menu's scroll bounds.
  useLayoutEffect(() => {
    const active = menuRef.current?.querySelector('[data-active="true"]')
    // Guarded: jsdom (and any non-layout host) has no scrollIntoView, and this is pure polish.
    if (active instanceof HTMLElement && typeof active.scrollIntoView === 'function') {
      active.scrollIntoView({ block: 'nearest' })
    }
  }, [props.activeIndex, props.options])

  return createPortal(
    <div
      ref={menuRef}
      id={props.id}
      className={`node-picker-menu ${props.className}`}
      role="listbox"
      aria-label={props.label}
      style={{
        position: 'fixed',
        top: position?.top ?? 0,
        left: position?.left ?? 0,
        visibility: position ? 'visible' : 'hidden'
      }}
      onMouseDown={(event) => event.preventDefault()}
    >
      {props.options.map((option, index) => (
        <button
          type="button"
          role="option"
          id={props.optionId(index)}
          key={option.key}
          aria-selected={index === props.activeIndex}
          data-active={index === props.activeIndex}
          onMouseEnter={() => props.highlight(index)}
          onClick={() => props.accept(index)}
        >
          <strong>
            <span>{option.label}</span>
            {option.hint && <em className="slash-command-hint">{option.hint}</em>}
          </strong>
          {option.description && <span>{option.description}</span>}
        </button>
      ))}
      {props.note && <small className="completion-menu-note">{props.note}</small>}
    </div>,
    document.body
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

/**
 * Reads the working directory's file index, and only while the composer is actually offering a
 * mention. The listing is fetched on each transition into offering one rather than per keystroke
 * (the main-process index is cached, so that costs at most one IPC round trip per `@` typed), and
 * a listing for a directory the node has since left is discarded rather than rendered - a
 * rehomed node must never be offered the previous tree's files.
 */
function useFileMentionIndex(source: ComposerFileMentions | undefined, offering: boolean): WorkspaceFileIndex | null {
  const [index, setIndex] = useState<WorkspaceFileIndex | null>(null)
  const readRef = useRef(source?.read)
  readRef.current = source?.read
  const root = source?.root
  useEffect(() => {
    if (!offering || !root) return
    let live = true
    void readRef.current?.(root).then(
      (next) => {
        if (live) setIndex(next)
      },
      // A directory that cannot be listed costs the completion and nothing else.
      () => {}
    )
    return () => {
      live = false
    }
  }, [offering, root])
  return index?.root === root ? index : null
}

/**
 * Both completions remember two things per token - what Escape dismissed and what was just
 * accepted - and both must forget them the moment the draft stops offering that token: keeping
 * the memory would silently refuse to complete the next identical token typed in its place. The
 * highlight goes back to the top whenever the token itself changes. Sharing one hook is what
 * keeps the two pickers from drifting apart over either rule.
 */
function useCompletionTokenMemory<State>(
  token: { query: string; start: number } | null,
  empty: State,
  resetHighlight: (state: State) => State,
  setState: (next: State | ((current: State) => State)) => void
): void {
  const offering = token !== null
  useEffect(() => {
    if (!offering) setState(empty)
  }, [offering])
  useEffect(() => setState(resetHighlight), [token?.query, token?.start])
}

type ComposerProps = ChatComposerProps &
  Pick<ChatTranscriptProps, 'provider' | 'messages' | 'commands'> &
  Pick<ChatSessionControlsProps, 'status' | 'detail'>

export function Composer(props: ComposerProps): JSX.Element {
  const busy = props.status === 'working'
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const composerDisabled = isSendDisabled(props.status)
  const { sendKey } = useComposerSendKey()
  const completionId = useId()
  // Draft input is intentionally local to this leaf. Publishing every keystroke through the
  // conversation hook rerenders the chat panel, including transcript Markdown,
  // persistence, and decision parsing. None of that work owns the input value.
  const [draft, setDraft] = useState(props.draft)
  const [pasteBlocked, setPasteBlocked] = useState(false)
  const [history, setHistory] = useState(emptyPromptHistory)
  // A conversation loaded from disk already shows what was asked; ArrowUp should be able to walk
  // back through it too, rather than starting blank above a full transcript.
  useEffect(() => {
    setHistory((current) =>
      seedPromptHistory(
        current,
        props.messages.filter((message) => message.role === 'user').map((message) => message.text)
      )
    )
  }, [props.messages])
  /** The last value this composer handed upward, so the round trip back down is not mistaken
   *  for an outside edit and does not fight what is being typed right now. */
  const publishedDraftRef = useRef(props.draft)
  const onDraftChangeRef = useRef(props.onDraftChange)
  onDraftChangeRef.current = props.onDraftChange

  useEffect(() => {
    if (props.draft === publishedDraftRef.current) return
    publishedDraftRef.current = props.draft
    setDraft(props.draft)
  }, [props.draft])

  // Debounced, so keeping a draft alive across resize/collapse/reload costs one workspace write
  // per typing pause rather than one per keystroke.
  useEffect(() => {
    if (draft === publishedDraftRef.current) return
    const timeout = setTimeout(() => {
      publishedDraftRef.current = draft
      onDraftChangeRef.current?.(draft)
    }, 300)
    return () => clearTimeout(timeout)
  }, [draft])

  // Going away mid-debounce (the node goes dormant, the workspace closes) must not cost the last
  // few keystrokes, so whatever the debounce still owed is flushed on the way out.
  const draftRef = useRef(draft)
  draftRef.current = draft
  useEffect(
    () => () => {
      if (draftRef.current !== publishedDraftRef.current) onDraftChangeRef.current?.(draftRef.current)
    },
    []
  )

  // The box grows with its content up to a bounded height, then scrolls. Measured against the
  // real element because only the browser knows how the text actually wrapped.
  useLayoutEffect(() => {
    const element = textareaRef.current
    if (!element) return
    element.style.height = 'auto'
    const { height, scrollable } = composerTextareaSize(element.scrollHeight)
    element.style.height = `${height}px`
    element.style.overflowY = scrollable ? 'auto' : 'hidden'
  }, [draft, props.attachments, props.queued])

  // React Flow zooms on any wheel it sees, and the composer is not covered by a static `nowheel`
  // because it should only claim the gesture while it actually has somewhere to scroll. The
  // listener is native and bound to the element so it runs before d3-zoom's own listener on the
  // pane above it - React's delegated handler at the app root would fire too late to stop it.
  useEffect(() => {
    const element = textareaRef.current
    if (!element) return
    const onWheel = (event: WheelEvent): void => {
      if (composerConsumesWheel(element, event.deltaY)) event.stopPropagation()
    }
    element.addEventListener('wheel', onWheel)
    return () => element.removeEventListener('wheel', onWheel)
  }, [])

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

  const applyHistory = (next: { state: typeof history; draft: string }): void => {
    setHistory(next.state)
    setDraft(next.draft)
  }

  // Where the caret sits decides whether a slash token is being typed at all, so the completion
  // tracks it rather than guessing from the draft's end - a caret parked mid-token still completes.
  const [caret, setCaret] = useState(0)
  const [completionState, setCompletionState] = useState(emptySlashCompletion)
  const [mentionState, setMentionState] = useState(emptyFileMentionCompletion)
  const editable = composerDisabled ? '' : draft
  const completion = slashCompletionView(editable, caret, props.commands ?? [], completionState)
  // The workspace listing is read only while a mention is actually being typed, so a conversation
  // nobody points at a file never costs a directory walk.
  const mentionIndex = useFileMentionIndex(props.fileMentions, fileMentionQuery(editable, caret) !== null)
  const mention = fileMentionCompletionView(
    editable,
    caret,
    mentionIndex,
    props.fileMentions?.recent ?? [],
    mentionState
  )
  // One word can hold both tokens (`/fo@o`), so the one starting closer to the caret is the one
  // being typed, and it takes the menu and the keys. Only ever one of them is open.
  const mentionActive =
    mention.open &&
    mention.token !== null &&
    (!completion.open || completion.token === null || mention.token.start > completion.token.start)
  const slashActive = completion.open && !mentionActive
  useCompletionTokenMemory(
    completion.token,
    emptySlashCompletion,
    (current) => highlightSlashCommand(current, 0),
    setCompletionState
  )
  useCompletionTokenMemory(
    mention.token,
    emptyFileMentionCompletion,
    (current) => highlightFileMention(current, 0),
    setMentionState
  )

  /** Set by an acceptance so the caret can be restored once React has rendered the new draft. */
  const pendingCaretRef = useRef<number | null>(null)
  useLayoutEffect(() => {
    const target = pendingCaretRef.current
    if (target === null) return
    pendingCaretRef.current = null
    const element = textareaRef.current
    if (!element) return
    element.focus()
    element.setSelectionRange(target, target)
    setCaret(target)
  }, [draft])

  const acceptCompletion = (command: AgentCommand): void => {
    if (!completion.token) return
    const next = acceptSlashCommand(draft, caret, completion.token, command)
    setDraft(next.draft)
    setHistory(leaveHistory)
    setCompletionState((current) => acceptedSlashCompletion(current, command))
    pendingCaretRef.current = next.caret
  }

  const acceptMention = (entry: WorkspaceFileEntry | undefined): void => {
    if (!mention.token || !entry) return
    const next = acceptFileMention(draft, caret, mention.token, entry)
    setDraft(next.draft)
    setHistory(leaveHistory)
    setMentionState((current) => acceptedFileMention(current, entry))
    pendingCaretRef.current = next.caret
  }

  /** Neither picker should keep hovering once the composer has lost focus. */
  const dismissCompletion = (): void => {
    setCompletionState((current) => dismissSlashCompletion(current, completion.token))
    setMentionState((current) => dismissFileMentionCompletion(current, mention.token))
  }

  /** The open picker's keyboard contract, or null when neither is offering anything. */
  const activeCompletion = mentionActive
    ? {
        count: mention.matches.length,
        index: mention.activeIndex,
        highlight: (next: number) => setMentionState((current) => highlightFileMention(current, next)),
        dismiss: () => setMentionState((current) => dismissFileMentionCompletion(current, mention.token)),
        accept: () => acceptMention(mention.matches[mention.activeIndex])
      }
    : slashActive
      ? {
          count: completion.matches.length,
          index: completion.activeIndex,
          highlight: (next: number) => setCompletionState((current) => highlightSlashCommand(current, next)),
          dismiss: () => setCompletionState((current) => dismissSlashCompletion(current, completion.token)),
          accept: () => acceptCompletion(completion.matches[completion.activeIndex])
        }
      : null

  /** Returns true when the completion has claimed the key press, so the composer's own bindings stay out of it. */
  const handleCompletionKey = (event: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!activeCompletion || event.nativeEvent.isComposing) return false
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      activeCompletion.highlight(
        moveSlashSelection(activeCompletion.index, activeCompletion.count, event.key === 'ArrowDown' ? 1 : -1)
      )
      return true
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      activeCompletion.dismiss()
      return true
    }
    // Shift/Alt+Enter still means "newline" here; only a plain accept keystroke picks an entry.
    if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey && !event.altKey)) {
      event.preventDefault()
      activeCompletion.accept()
      return true
    }
    return false
  }

  return (
    <form
      className="chat-composer nodrag"
      onSubmit={(event) => {
        const sent = draft
        props.submit(event, draft, () => {
          setDraft('')
          setHistory((current) => rememberPrompt(current, sent))
        })
      }}
    >
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
        <textarea
          ref={textareaRef}
          rows={1}
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value)
            setCaret(event.target.selectionStart ?? event.target.value.length)
            setHistory(leaveHistory)
            setPasteBlocked(false)
          }}
          onSelect={(event) => setCaret(event.currentTarget.selectionStart ?? 0)}
          onPaste={handlePaste}
          onKeyDown={(event) => {
            if (handleCompletionKey(event)) return
            const action = composerKeyAction(
              {
                key: event.key,
                shiftKey: event.shiftKey,
                ctrlKey: event.ctrlKey,
                metaKey: event.metaKey,
                altKey: event.altKey,
                isComposing: event.nativeEvent.isComposing
              },
              { sendKey, draft, historyActive: history.index !== null }
            )
            if (action === 'send') {
              event.preventDefault()
              event.currentTarget.form?.requestSubmit()
            } else if (action === 'history-previous') {
              event.preventDefault()
              applyHistory(recallPrevious(history, draft))
            } else if (action === 'history-next') {
              event.preventDefault()
              applyHistory(recallNext(history))
            } else if (action === 'history-cancel') {
              event.preventDefault()
              setDraft(history.stashedDraft)
              setHistory(leaveHistory)
            }
          }}
          placeholder="Message the agent..."
          disabled={composerDisabled}
          // The menu is a portal, so focus leaving the composer entirely (not into the menu, whose
          // mousedown is suppressed) means the captain has moved on and it should stop hovering.
          onBlur={dismissCompletion}
          aria-expanded={activeCompletion !== null}
          aria-controls={activeCompletion ? completionId : undefined}
          aria-activedescendant={activeCompletion ? `${completionId}-${activeCompletion.index}` : undefined}
        />
        {slashActive && (
          <CompletionMenu
            anchorRef={textareaRef}
            id={completionId}
            className="slash-command-menu"
            label="Slash commands"
            options={completion.matches.map((command) => ({
              key: command.name,
              label: `/${command.name}`,
              hint: command.input?.hint,
              description: command.description
            }))}
            activeIndex={completion.activeIndex}
            optionId={(index) => `${completionId}-${index}`}
            accept={(index) => acceptCompletion(completion.matches[index])}
            highlight={(index) => setCompletionState((current) => highlightSlashCommand(current, index))}
          />
        )}
        {mentionActive && (
          <CompletionMenu
            anchorRef={textareaRef}
            id={completionId}
            className="file-mention-menu"
            label="Workspace files"
            options={mention.matches.map((entry) => ({
              key: entry.path,
              label: entry.directory ? `${entry.path}/` : entry.path,
              hint: props.fileMentions?.recent.includes(entry.path) ? 'already read' : undefined
            }))}
            activeIndex={mention.activeIndex}
            optionId={(index) => `${completionId}-${index}`}
            accept={(index) => acceptMention(mention.matches[index])}
            highlight={(index) => setMentionState((current) => highlightFileMention(current, index))}
            note={fileMentionExclusionNote(mentionIndex)}
          />
        )}
      </div>
      {/* Dictation, stop, and send sit in the footer rather than beside the textarea: stretched
          alongside a growing input they ballooned with it. */}
      <div className="composer-footer">
        <ComposerToolbar {...props} />
        <div className="composer-actions">
          <VoiceInputPrototype
            draft={draft}
            disabled={composerDisabled}
            textareaRef={textareaRef}
            setDraft={setDraft}
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
            disabled={(!draft.trim() && props.attachments.length === 0) || composerDisabled}
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

function StructuredDecisionPanel(
  props: Pick<FlatChatViewProps, 'decisionRequest' | 'resolveElicitation'>
): JSX.Element | null {
  const request = props.decisionRequest
  const [active, setActive] = useState(0)
  const [answers, setAnswers] = useState<AgentDecisionResponseContent>({})
  const [resolving, setResolving] = useState(false)
  const resolutionStarted = useRef(false)
  const headingId = useId()
  const questionTabs = useRef<Array<HTMLButtonElement | null>>([])
  const pendingQuestionFocus = useRef<number | null>(null)
  useLayoutEffect(() => {
    if (pendingQuestionFocus.current !== active) return
    questionTabs.current[active]?.focus()
    pendingQuestionFocus.current = null
  }, [active])
  if (!request || !props.resolveElicitation) return null
  const question = request.questions[active]
  if (!question) return null
  const currentAnswer = answers[question.id]
  const answered = (item: AgentDecisionRequest['questions'][number]): boolean => {
    const custom = item.customAnswerId ? answers[item.customAnswerId] : undefined
    const selected = answers[item.id]
    return (
      (typeof custom === 'string' && custom.trim() !== '') ||
      (typeof selected === 'string'
        ? selected !== ''
        : Array.isArray(selected)
          ? selected.length > 0
          : selected !== undefined)
    )
  }
  const requiredComplete = request.questions.every((item) => !item.required || answered(item))
  const requiredRemaining = request.questions.filter((item) => item.required && !answered(item)).length
  const questionLabel = (item: AgentDecisionRequest['questions'][number], index: number): string =>
    `Question ${index + 1}: ${item.title ?? item.question}${answered(item) ? ', answered' : ''}`
  const activateTab = (index: number, tabList: HTMLElement): void => {
    setActive(index)
    const tabs = tabList.querySelectorAll<HTMLButtonElement>('[role="tab"]')
    tabs[index]?.focus()
  }
  const advanceTo = (index: number): void => {
    pendingQuestionFocus.current = index
    setActive(index)
  }
  const resolveOnce = (content?: AgentDecisionResponseContent): void => {
    if (resolutionStarted.current) return
    resolutionStarted.current = true
    setResolving(true)
    props.resolveElicitation!(request.id, content)
  }
  const choose = (value: string): void => {
    setAnswers((current) => {
      const next = { ...current }
      if (question.customAnswerId) delete next[question.customAnswerId]
      if (!question.multiSelect) return { ...next, [question.id]: value }
      const selected = Array.isArray(current[question.id]) ? (current[question.id] as string[]) : []
      return {
        ...next,
        [question.id]: selected.includes(value) ? selected.filter((item) => item !== value) : [...selected, value]
      }
    })
    if (!question.multiSelect && active < request.questions.length - 1) advanceTo(active + 1)
  }
  return (
    <section className="structured-decision" aria-labelledby={headingId} aria-describedby={`${headingId}-context`}>
      <header className="structured-decision-header">
        <div className="structured-decision-heading">
          <span className="structured-decision-icon" aria-hidden="true">
            <ListChecks />
          </span>
          <div>
            <strong id={headingId}>Decision questions</strong>
            <p id={`${headingId}-context`}>{request.message}</p>
          </div>
        </div>
        <span className="structured-decision-count">
          {request.questions.filter(answered).length}/{request.questions.length} answered
        </span>
      </header>
      {request.questions.length > 1 && (
        <div className="structured-decision-tabs" role="tablist" aria-label="Questions">
          {request.questions.map((item, index) => (
            <button
              type="button"
              role="tab"
              aria-selected={index === active}
              aria-label={questionLabel(item, index)}
              aria-controls={`${headingId}-panel`}
              id={`${headingId}-tab-${index}`}
              ref={(element) => {
                questionTabs.current[index] = element
              }}
              tabIndex={index === active ? 0 : -1}
              data-answered={answered(item)}
              key={item.id}
              onClick={() => setActive(index)}
              onKeyDown={(event) => {
                const last = request.questions.length - 1
                const next =
                  event.key === 'ArrowRight'
                    ? index === last
                      ? 0
                      : index + 1
                    : event.key === 'ArrowLeft'
                      ? index === 0
                        ? last
                        : index - 1
                      : event.key === 'Home'
                        ? 0
                        : event.key === 'End'
                          ? last
                          : null
                if (next === null) return
                event.preventDefault()
                activateTab(next, event.currentTarget.parentElement!)
              }}
            >
              <span>{answered(item) ? <Check aria-hidden="true" /> : index + 1}</span>
              <small>{item.title ?? `Question ${index + 1}`}</small>
            </button>
          ))}
        </div>
      )}
      <article
        className="structured-decision-question"
        id={`${headingId}-panel`}
        data-scroll-region="question"
        role={request.questions.length > 1 ? 'tabpanel' : undefined}
        aria-labelledby={request.questions.length > 1 ? `${headingId}-tab-${active}` : `${headingId}-question`}
      >
        <div className="structured-decision-progress">
          <span>
            Question {active + 1} of {request.questions.length}
          </span>
          {question.required && <span className="structured-decision-required">Required</span>}
        </div>
        {question.title && <strong>{question.title}</strong>}
        <p id={`${headingId}-question`}>{question.question}</p>
        {question.input === 'select' && (
          <div className="structured-decision-options" role="group" aria-labelledby={`${headingId}-question`}>
            {question.options.map((option) => {
              const value = answers[question.id]
              const selected = Array.isArray(value) ? value.includes(option.value) : value === option.value
              return (
                <button type="button" aria-pressed={selected} key={option.value} onClick={() => choose(option.value)}>
                  <span>{option.label}</span>
                  {option.description && <small>{option.description}</small>}
                </button>
              )
            })}
          </div>
        )}
        {question.input === 'boolean' && (
          <div className="structured-decision-options" role="group" aria-labelledby={`${headingId}-question`}>
            {(['Yes', 'No'] as const).map((label) => {
              const value = label === 'Yes'
              return (
                <button
                  type="button"
                  aria-pressed={answers[question.id] === value}
                  key={label}
                  onClick={() => {
                    setAnswers((current) => ({ ...current, [question.id]: value }))
                    if (active < request.questions.length - 1) advanceTo(active + 1)
                  }}
                >
                  <span>{label}</span>
                </button>
              )
            })}
          </div>
        )}
        {question.input === 'text' && (
          <input
            className="structured-decision-value"
            type="text"
            aria-label={question.question}
            value={typeof currentAnswer === 'string' ? currentAnswer : ''}
            onChange={(event) => setAnswers((current) => ({ ...current, [question.id]: event.target.value }))}
          />
        )}
        {question.input === 'number' && (
          <input
            className="structured-decision-value"
            type="number"
            aria-label={question.question}
            value={typeof currentAnswer === 'number' ? currentAnswer : ''}
            onChange={(event) => {
              const value = event.target.value
              setAnswers((current) => {
                const next = { ...current }
                if (value === '') delete next[question.id]
                else next[question.id] = Number(value)
                return next
              })
            }}
          />
        )}
        {question.customAnswerId && (
          <label className="structured-decision-other">
            <span>Other answer</span>
            <input
              type="text"
              value={
                typeof answers[question.customAnswerId] === 'string' ? (answers[question.customAnswerId] as string) : ''
              }
              onChange={(event) => {
                const value = event.target.value
                setAnswers((current) => {
                  const next = { ...current }
                  if (value.trim()) {
                    delete next[question.id]
                    next[question.customAnswerId!] = value
                  } else {
                    delete next[question.customAnswerId!]
                  }
                  return next
                })
              }}
            />
          </label>
        )}
      </article>
      <nav className="structured-decision-navigation" aria-label="Question navigation">
        <button type="button" disabled={active === 0} onClick={() => setActive((value) => value - 1)}>
          Previous question
        </button>
        <button
          type="button"
          disabled={active === request.questions.length - 1}
          onClick={() => setActive((value) => value + 1)}
        >
          Next question
        </button>
      </nav>
      <footer>
        <span role="status" aria-live="polite">
          {requiredRemaining === 0
            ? 'Ready to submit'
            : `${requiredRemaining} required answer${requiredRemaining === 1 ? '' : 's'} remaining`}
        </span>
        <button className="structured-decision-skip" type="button" disabled={resolving} onClick={() => resolveOnce()}>
          Skip
        </button>
        {active === request.questions.length - 1 && (
          <button type="button" disabled={!requiredComplete || resolving} onClick={() => resolveOnce(answers)}>
            Submit answers
          </button>
        )}
      </footer>
    </section>
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
        {!(images.length > 0 && !message.text) && <MarkdownMessage text={message.text} />}
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
  const { transcript, composer, pending, session } = groups
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

/** The sidebar only cares whether the agent is busy, blocked, waiting on us, or stuck. */
function sidebarStatus(
  status: AgentChatStatus,
  awaitingApproval: boolean,
  unreadKind: AttentionKind | undefined,
  stalled: boolean
): TerminalNodeStatus {
  if (status === 'exited') return 'exited'
  if (status === 'auth_required' || awaitingApproval) return 'attention'
  if (status === 'starting') return 'starting'
  if (status === 'working') return stalled ? 'stalled' : 'working'
  // A dormant node has no live approval or auth state left, so the record is the only thing that
  // still knows the session was blocked - reading it back as a mere 'result' would understate it.
  if (unreadKind === 'approval' || unreadKind === 'auth' || unreadKind === 'failure') return 'attention'
  return unreadKind ? 'result' : 'idle'
}

export default function ChatNode({ id, data, selected }: NodeProps<TerminalCanvasNode>): JSX.Element {
  const previousStatusRef = useRef<AgentChatStatus>('starting')
  const previousFinalAnswerCountRef = useRef(0)
  const turnStartFinalAnswerCountRef = useRef(0)
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
  const { status, approval, decisionRequest, detail, failure, failureKey, messages, activities, plan, usage } =
    conversation
  const [renaming, setRenaming] = useState(false)
  const [titleDraft, setTitleDraft] = useState(data.label)
  const [titleError, setTitleError] = useState(false)
  const persistedOutcomeIdsRef = useRef(new Set((data.turnOutcomes ?? []).map((outcome) => outcome.id)))
  useEffect(() => {
    for (const outcome of conversation.outcomes) {
      if (persistedOutcomeIdsRef.current.has(outcome.id)) continue
      persistedOutcomeIdsRef.current.add(outcome.id)
      data.onTurnOutcome?.(id, outcome)
    }
  }, [conversation.outcomes, data.onTurnOutcome, id])
  const outcomes = useMemo(() => {
    const byId = new Map((data.turnOutcomes ?? []).map((outcome) => [outcome.id, outcome]))
    for (const outcome of conversation.outcomes) byId.set(outcome.id, outcome)
    return [...byId.values()]
  }, [conversation.outcomes, data.turnOutcomes])

  useEffect(() => {
    if (data.titleSource || !data.conversationId || status !== 'ready') return
    const title = deriveConversationTitle(
      messages
        .filter(
          (message): message is AgentChatMessage & { role: 'user' | 'assistant' } =>
            message.role === 'user' || isFinalAssistantMessage(message)
        )
        .map(({ role, text, presentation }) => ({ role, text, presentation }))
    )
    if (title) void data.onTitleChange(id, title, 'generated').then((saved) => setTitleError(!saved))
  }, [data, data.conversationId, data.titleSource, id, messages, status])

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
  const [stalled, setStalled] = useState(false)
  const lastProgressAtRef = useRef(Date.now())

  // Attention is a durable record owned by the workspace, not a flag this node recomputes: the
  // node only reports the condition and the key that identifies it. Every key below is stable
  // across ACP session replay, which is what keeps a restored conversation from re-raising
  // something the user already dealt with (see shared/attention.ts).
  const unread = data.unread ?? 0
  const reportAttention = data.onAttention
  // The ACP conversation once there is one; until then the node's durable session id, so an
  // early approval or failure is never persisted without any source identity at all.
  const attentionSource = data.conversationId ?? data.sessionId

  // A turn that finished while the user was looking elsewhere is a result they have not read.
  // Keyed by the answer itself, so a replayed transcript lands on the record it already made.
  useEffect(() => {
    const finalAnswers = messages.filter(isFinalAssistantMessage)
    const previousStatus = previousStatusRef.current
    if (previousStatus !== 'working' && status === 'working') {
      turnStartFinalAnswerCountRef.current = previousFinalAnswerCountRef.current
    }
    const finishedTurn = previousStatus === 'working' && status === 'ready'
    previousStatusRef.current = status
    previousFinalAnswerCountRef.current = finalAnswers.length
    if (!finishedTurn || selected) return
    const answer = finalAnswers.slice(turnStartFinalAnswerCountRef.current).at(-1)
    if (!answer) return
    reportAttention?.({
      type: 'raise',
      signal: {
        nodeId: id,
        kind: 'result',
        key: attentionTextKey(`${answer.id}:${answer.text}`),
        sourceId: attentionSource,
        summary: `${data.label} finished a turn`
      }
    })
  }, [attentionSource, data.label, id, messages, reportAttention, selected, status])

  // A request the session is parked on is its own condition: the ACP request id is the key, so the
  // same request seen twice is one record, and answering it retires that record rather than
  // marking it read. A tool permission and a structured question set are one condition here, not
  // two - both are the agent waiting on an answer, and a chat stalled on either has to be findable
  // from a list (the phone's "needs approval" badge reads exactly this record).
  const requestId = approval?.id ?? decisionRequest?.id ?? null
  const requestTitle = approval?.title ?? decisionRequest?.message
  const previousRequestRef = useRef<string | null>(null)
  useEffect(() => {
    const previous = previousRequestRef.current
    previousRequestRef.current = requestId
    if (previous && previous !== requestId) {
      reportAttention?.({ type: 'resolve', nodeId: id, kind: 'approval', key: previous })
    }
    if (!requestId) return
    reportAttention?.({
      type: 'raise',
      signal: {
        nodeId: id,
        kind: 'approval',
        key: requestId,
        sourceId: attentionSource,
        summary: requestTitle ?? `${data.label} needs approval`
      }
    })
  }, [attentionSource, data.label, id, reportAttention, requestId, requestTitle])

  // Sign-in is a standing condition rather than an event, so it is raised while it holds and
  // retired the moment the session gets past it.
  const authRequired = status === 'auth_required'
  useEffect(() => {
    if (!authRequired) {
      reportAttention?.({ type: 'resolve', nodeId: id, kind: 'auth' })
      return
    }
    reportAttention?.({
      type: 'raise',
      signal: {
        nodeId: id,
        kind: 'auth',
        key: 'auth',
        sourceId: attentionSource,
        summary: `${data.label} needs you to sign in`
      }
    })
  }, [attentionSource, authRequired, data.label, id, reportAttention])

  // Failures are keyed by their text: the same error reported again - live or replayed - is the
  // same condition, while a different one is worth its own record.
  useEffect(() => {
    if (!failure) return
    reportAttention?.({
      type: 'raise',
      signal: {
        nodeId: id,
        kind: 'failure',
        key: failureKey ?? attentionTextKey(failure),
        sourceId: attentionSource,
        summary: failure
      }
    })
  }, [attentionSource, failure, failureKey, id, reportAttention])

  /**
   * Having the node open is the user reaching its content, so anything raised while it is
   * selected clears too - but only the kinds reading actually settles. A pending approval or
   * sign-in request stays unread until it is answered (READ_ON_VIEW_KINDS), because glancing at
   * a blocked turn is not unblocking it. Marking unread on a node you are looking at would
   * otherwise be undone by this effect on the very next render, so that hold survives until the
   * node is left and re-entered.
   */
  const unreadHoldRef = useRef(false)
  useEffect(() => {
    if (!selected) unreadHoldRef.current = false
    if (!selected || data.dormant || unread === 0 || unreadHoldRef.current) return
    reportAttention?.({ type: 'read', nodeId: id, kinds: READ_ON_VIEW_KINDS })
  }, [data.dormant, id, reportAttention, selected, unread])

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
    // Either kind of pending request is the same thing to a list: the agent is waiting on you.
    const waiting = approval !== null || decisionRequest !== null
    data.onStatusChange(id, sidebarStatus(status, waiting, data.unreadKind, stalled))
  }, [approval, data.dormant, data.onStatusChange, data.unreadKind, decisionRequest, id, status, stalled])

  /**
   * What this session has been writing, for the ticket board's live card. Paths go up, not
   * tickets: which of them is a ticket depends on the project's tickets folder, which the
   * workspace knows and a node does not (`ticket-activity.ts`). Where the running turn began is
   * observed here because this is the only place that sees the status change - a steer sent
   * mid-turn is another message from the captain, and the transcript alone cannot tell the two
   * apart. The report fires on a change of *contents*, not on every streamed event.
   */
  const reportTicketActivity = data.onTicketActivity
  const turnStartedAtRef = useRef<number | undefined>(undefined)
  const turnWasRunningRef = useRef(false)
  const reportedTurnRef = useRef<string | undefined>(undefined)
  useEffect(() => {
    const working = status === 'working'
    // The turn's own start, taken when it begins and kept once it ends: between turns the turn
    // that just finished *is* the last completed one, and its writes are what the card shows.
    if (working && !turnWasRunningRef.current) turnStartedAtRef.current = conversation.transcript.length
    turnWasRunningRef.current = working
    const paths = recentlyWrittenPaths(conversation.transcript, activities, {
      working,
      startedAt: turnStartedAtRef.current
    })
    // Reported on a change of contents, not on every streamed event of a turn.
    const reported = `${working}\n${paths.join('\n')}`
    if (reported === reportedTurnRef.current) return
    reportedTurnRef.current = reported
    reportTicketActivity?.(id, { paths, working })
  }, [activities, conversation.transcript, id, reportTicketActivity, status])

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
        {titleError && (
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
        <span className="chat-provider-badge">ACP</span>
        <UnreadToggle
          unread={unread}
          onToggle={(next) => {
            unreadHoldRef.current = next === 'unread'
            reportAttention?.(
              next === 'unread'
                ? { type: 'unread', nodeId: id }
                : { type: 'read', nodeId: id, kinds: READ_ON_VIEW_KINDS }
            )
          }}
        />
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
          />
        </>
      )}
    </article>
  )
}

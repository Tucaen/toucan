import { useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { type NodeProps } from '@xyflow/react'
import MarkdownMessage from './MarkdownMessage'
import WorktreeBadge from './WorktreeBadge'
import type {
  AgentActivity,
  AgentAuthMethod,
  AgentCommand,
  AgentEffortState,
  AgentModeState,
  AgentModelState,
  AgentPlanEntry
} from '../../shared/agent'
import { activityTitle } from '../../shared/agent-activity'
import { isNearScrollBottom } from './chat-scroll-follow'
import type { TerminalCanvasNode, TerminalNodeStatus } from './canvas-workspace'
import {
  computeNodePickerMenuPosition,
  type NodePickerMenuOptions,
  type NodePickerMenuSize
} from './node-picker-menu-position'
import { imageFilesFromClipboard, type AgentImageAttachment } from './image-attachment'
import { classifyAssistantMessage, type DecisionOption } from './decision-message'
import { pendingDecisionsFromMessages, type PendingDecision } from './pending-decisions'
import NodeBorderResizer from './NodeBorderResizer'
import VoiceInputPrototype from './VoiceInputPrototype'
import { composerTextareaSize } from './composer-autosize'
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
  composerKeyAction,
  composerSendKeyLabels,
  type ComposerSendKey
} from './composer-keys'
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
import type { QueuedPrompt } from './prompt-outbox'
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
  /** Follow-ups still held in the renderer while a turn runs; see prompt-outbox.ts. */
  queued: QueuedPrompt[]
  /**
   * The slash commands and skills the connected session advertises over ACP. Optional because a
   * chat view renders perfectly well before an agent has published any - the completion simply
   * has nothing to offer until then.
   */
  commands?: AgentCommand[]
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

const providerNames = { claude: 'Claude', codex: 'Codex' } as const

/** Mirrors `dispatchText`'s guard in use-agent-conversation.ts so a click can't silently no-op. */
function isSendDisabled(status: ChatViewProps['status']): boolean {
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
  provider: { icon: '@', heading: 'Provider', idle: 'Provider', hint: 'Choose the agent provider' },
  permission: { icon: '*', heading: 'Permission mode', idle: 'Permissions', hint: 'Set the permission mode for this agent' },
  model: { icon: '#', heading: 'Model', idle: 'Model', hint: 'Choose the model for this conversation' },
  effort: { icon: '~', heading: 'Thinking effort', idle: 'Effort', hint: 'Set the thinking effort for this conversation' },
  sendKey: { icon: '>', heading: 'Send with', idle: 'Send key', hint: 'Choose which key sends a message' }
} as const

/**
 * Positions a portal-rendered menu against an anchor inside a canvas node. Every floating menu in
 * here has to do this the same way - `.terminal-node` is `overflow: hidden`, so a CSS-anchored
 * menu clips the moment its node nears a canvas edge - so the measure/clamp/track loop lives once,
 * here. Returns null until the first measurement, which the caller renders as `visibility: hidden`
 * so the menu never flashes at the wrong place.
 */
function usePortalMenuPosition(
  anchorRef: RefObject<HTMLElement>,
  menuRef: RefObject<HTMLElement>,
  enabled: boolean,
  fallback: NodePickerMenuSize,
  options?: NodePickerMenuOptions,
  // Anything that can change the menu's own size (its option list, say) and so its placement.
  remeasureOn?: unknown
): { top: number; left: number } | null {
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null)

  useLayoutEffect(() => {
    if (!enabled) {
      setPosition(null)
      return
    }
    const reposition = (): void => {
      const anchor = anchorRef.current?.getBoundingClientRect()
      if (!anchor) return
      const menu = menuRef.current?.getBoundingClientRect()
      setPosition(computeNodePickerMenuPosition(
        anchor,
        { width: menu?.width || fallback.width, height: menu?.height ?? fallback.height },
        { width: window.innerWidth, height: window.innerHeight },
        options
      ))
    }
    reposition()
    window.addEventListener('resize', reposition)
    window.addEventListener('scroll', reposition, true)
    // The anchor can change size without the window doing anything - a composer growing with its
    // draft, a node dragged by its resize border - and the menu has to follow it.
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(reposition) : null
    if (anchorRef.current) observer?.observe(anchorRef.current)
    return () => {
      window.removeEventListener('resize', reposition)
      window.removeEventListener('scroll', reposition, true)
      observer?.disconnect()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchorRef, enabled, menuRef, remeasureOn])

  return position
}

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
            {option.id === props.selectedId && (
              <i className="node-picker-selected-marker" aria-hidden="true" />
            )}
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
        <span aria-hidden="true">{copy.icon}</span>
        {selected?.name ?? copy.idle}
        <span aria-hidden="true">⌄</span>
      </button>
      {menu && createPortal(menu, document.body)}
    </div>
  )
}

/**
 * The composer's slash-command list. Like `SelectorPicker` it portals to `<body>` and positions
 * itself in JS against its anchor's viewport rect - `.terminal-node` clips overflow, so a
 * CSS-anchored menu would be cut off the moment the node sits near a canvas edge. It opens above
 * the composer by preference, since the composer already sits at the bottom of its node.
 */
function SlashCommandMenu(props: {
  anchorRef: RefObject<HTMLElement>
  id: string
  options: AgentCommand[]
  activeIndex: number
  optionId(index: number): string
  accept(command: AgentCommand): void
  highlight(index: number): void
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
      className="node-picker-menu slash-command-menu"
      role="listbox"
      aria-label="Slash commands"
      style={{
        position: 'fixed',
        top: position?.top ?? 0,
        left: position?.left ?? 0,
        visibility: position ? 'visible' : 'hidden'
      }}
      onMouseDown={(event) => event.preventDefault()}
    >
      {props.options.map((command, index) => (
        <button
          type="button"
          role="option"
          id={props.optionId(index)}
          key={command.name}
          aria-selected={index === props.activeIndex}
          data-active={index === props.activeIndex}
          onMouseEnter={() => props.highlight(index)}
          onClick={() => props.accept(command)}
        >
          <strong>
            {`/${command.name}`}
            {command.input?.hint && <em className="slash-command-hint">{command.input.hint}</em>}
          </strong>
          {command.description && <span>{command.description}</span>}
        </button>
      ))}
    </div>,
    document.body
  )
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

/**
 * The composer's own settings row: what the conversation runs as, and how Enter behaves. Grouped
 * into one toolbar rather than scattered across the node header so the pickers read as a set and
 * can wrap together when the node is narrow.
 */
function ComposerToolbar(props: Pick<ChatViewProps,
  'provider' | 'modes' | 'models' | 'efforts' | 'selectorsDisabled' | 'selectMode' | 'selectModel' | 'selectEffort'
>): JSX.Element {
  const { sendKey, setSendKey } = useComposerSendKey()
  const disabled = props.selectorsDisabled ?? false
  return (
    <div className="composer-toolbar" role="group" aria-label="Conversation settings">
      <span className="composer-toolbar-provider" title={`This conversation runs on ${providerNames[props.provider]}`}>
        <span aria-hidden="true">{pickerCopy.provider.icon}</span>
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

export function Composer(props: Pick<ChatViewProps,
  'provider' | 'messages' | 'draft' | 'setDraft' | 'submit' | 'cancel' | 'status' | 'detail' | 'imageSupport'
  | 'attachments' | 'addImages' | 'removeAttachment' | 'onDraftChange'
  | 'queued' | 'editQueued' | 'withdrawQueued' | 'sendQueuedNow' | 'commands'
  | 'modes' | 'models' | 'efforts' | 'selectorsDisabled' | 'selectMode' | 'selectModel' | 'selectEffort'
>): JSX.Element {
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
    setHistory((current) => seedPromptHistory(
      current,
      props.messages.filter((message) => message.role === 'user').map((message) => message.text)
    ))
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
  useEffect(() => () => {
    if (draftRef.current !== publishedDraftRef.current) onDraftChangeRef.current?.(draftRef.current)
  }, [])

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
  const completion = slashCompletionView(
    composerDisabled ? '' : draft,
    caret,
    props.commands ?? [],
    completionState
  )
  // What Escape dismissed and what was just accepted are remembered per slash token; once the
  // draft has no token left (it was sent, cleared, or edited away) that memory is spent, and
  // keeping it would silently refuse to complete the next identical token typed in its place.
  const hasToken = completion.token !== null
  useEffect(() => {
    if (!hasToken) setCompletionState(emptySlashCompletion)
  }, [hasToken])
  useEffect(
    () => setCompletionState((current) => highlightSlashCommand(current, 0)),
    [completion.token?.query, completion.token?.start]
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

  const dismissCompletion = (): void => {
    setCompletionState((current) => dismissSlashCompletion(current, completion.token))
  }

  /** Returns true when the completion has claimed the key press, so the composer's own bindings stay out of it. */
  const handleCompletionKey = (event: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!completion.open || event.nativeEvent.isComposing) return false
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      setCompletionState((current) => highlightSlashCommand(
        current,
        moveSlashSelection(completion.activeIndex, completion.matches.length, event.key === 'ArrowDown' ? 1 : -1)
      ))
      return true
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      dismissCompletion()
      return true
    }
    // Shift/Alt+Enter still means "newline" here; only a plain accept keystroke picks a command.
    if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey && !event.altKey)) {
      event.preventDefault()
      acceptCompletion(completion.matches[completion.activeIndex])
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
      {pasteBlocked && (
        <small className="composer-paste-blocked">This agent doesn't support image attachments.</small>
      )}
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
          aria-expanded={completion.open}
          aria-controls={completion.open ? completionId : undefined}
          aria-activedescendant={completion.open ? `${completionId}-${completion.activeIndex}` : undefined}
        />
        {completion.open && (
          <SlashCommandMenu
            anchorRef={textareaRef}
            id={completionId}
            options={completion.matches}
            activeIndex={completion.activeIndex}
            optionId={(index) => `${completionId}-${index}`}
            accept={acceptCompletion}
            highlight={(index) => setCompletionState((current) => highlightSlashCommand(current, index))}
          />
        )}
        <VoiceInputPrototype
          draft={draft}
          disabled={composerDisabled}
          textareaRef={textareaRef}
          setDraft={setDraft}
        />
        {busy && <button type="button" className="stop-agent" onClick={props.cancel}>Stop</button>}
        <button
          type="submit"
          title={composerSendKeyLabels[sendKey].description}
          disabled={(!draft.trim() && props.attachments.length === 0) || composerDisabled}
        >
          {busy ? 'Queue' : 'Send'}
        </button>
      </div>
      <ComposerToolbar {...props} />
    </form>
  )
}

function AuthPanel(
  props: Pick<
    ChatViewProps,
    | 'provider'
    | 'authMethods'
    | 'authLink'
    | 'reauthenticating'
    | 'authenticate'
    | 'submitAuthCode'
    | 'openAuthLink'
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
          <span className="auth-lock" aria-hidden="true">*</span>
        <div>
            <strong id={titleId}>Sign in to {providerNames[props.provider]}</strong>
            <p id={descriptionId}>No sign-in method is available for this session. Restart the conversation to try again.</p>
          </div>
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
    <section {...dialogProps}>
      <div className="chat-auth-card">
        <span className="auth-lock" aria-hidden="true">*</span>
      <div>
          <strong id={titleId}>Sign in to {providerNames[props.provider]}</strong>
          <p id={descriptionId}>Connect your existing subscription to enable messages and voice input.</p>
          <button
            type="button"
            disabled={props.reauthenticating}
            onClick={() => props.authenticate(method.id)}
          >
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
                      else setCodeError('ADE could not send the code. Start sign-in again and retry.')
                      setSubmittingCode(false)
                    })
                  }}
                >
                  <label htmlFor={codeInputId}>Paste the code shown in your browser</label>
                  <small>Only needed if the browser asks you to paste a code back into ADE.</small>
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
                  {codeError && <small className="auth-code-error" role="alert">{codeError}</small>}
                </form>
        )}
            </>
          )}
        </div>
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

/**
 * Renders a pending decision's extracted options as clickable buttons plus a free-text "Other"
 * field. Both paths reuse the ordinary prompt/steering delivery path with decision identity rather
 * than introducing a protocol-level channel; see pending-decisions.ts for state folding.
 */
function DecisionOptions(
  props: { decisionId?: string; options: DecisionOption[]; answerDecision: ChatViewProps['answerDecision']; status: ChatViewProps['status']; submitting?: boolean }
): JSX.Element {
  const [otherText, setOtherText] = useState('')
  const disabled = isSendDisabled(props.status) || props.submitting
  const send = (text: string): void => props.answerDecision(props.decisionId ?? '', text)
  return (
    <div className="decision-options">
      <div className="decision-options-buttons">
        {props.options.map((option) => (
          <button
            type="button"
            key={option.id}
            disabled={disabled}
            onClick={() => send(option.label)}
          >
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
        <button type="submit" disabled={disabled || !otherText.trim()}>Send</button>
      </form>
    </div>
  )
}

function decisionQuestion(text: string): string {
  return text.split('\n').map((line) => line.trim()).filter(Boolean).at(-1) ?? 'Choose an option.'
}

/** Classifies assistant replies for visual tone (see decision-message.ts). */
function ChatMessageCard(
  props: {
    message: AgentChatMessage
  }
): JSX.Element {
  const { message } = props
  const tone = message.role === 'assistant' ? classifyAssistantMessage(message.text) : 'normal'
  return (
    <article
      className={`chat-message ${message.role}${message.queued ? ' queued' : ''}${message.failed ? ' failed' : ''}`}
      data-tone={tone}
    >
      <div>
        <MarkdownMessage text={message.text} />
        {message.failed
          ? <small className="failed-badge">Not sent — delivery was rejected</small>
          : message.queued && <small className="queued-badge">Queued — will send once the agent is free</small>}
      </div>
    </article>
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
  completedTaskIds?: ReadonlySet<string>
  closedDecisionIds?: ReadonlySet<string>
}): JSX.Element {
  const workItemCount = props.activities.length + props.plan.length
  const authVisible = props.status === 'auth_required' || props.reauthenticating
  const pendingDecisions = pendingDecisionsFromMessages(
    props.messages,
    props.completedTaskIds,
    props.closedDecisionIds
  )
  const { ref: scrollRef, onScroll } = useStickToBottom([props.messages, props.approval, props.status])
  return (
    <div className={`agent-chat ${props.worklogCollapsed ? 'worklog-collapsed' : ''} ${props.statusBar ? 'has-status-bar' : ''} ${pendingDecisions.length > 0 ? 'has-pending-decisions' : ''}`}>
      <div className="chat-scroll nodrag nopan nowheel" ref={scrollRef} onScroll={onScroll}>
        {!authVisible && props.messages.length === 0 && (props.empty
            ? (
              <div className="chat-empty">
                <span>{props.empty.icon}</span>
                <strong>{props.empty.title}</strong>
                <p>{props.empty.description}</p>
              </div>
            )
            : <EmptyConversation provider={props.provider} />)}
        {props.messages.map((message) => message.role === 'thought'
          ? <details className="thought-card" key={message.id}><summary>Reasoning</summary><MarkdownMessage text={message.text} /></details>
          : (
            <ChatMessageCard
              key={message.id}
              message={message}
            />
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
      {pendingDecisions.length > 0 && (
        <section className="pending-decisions" aria-label="Pending decisions">
          {pendingDecisions.map((decision: PendingDecision) => (
            <article key={decision.id} data-state={decision.state}>
              <header><strong>Decision needed</strong>{decision.taskId && <small>{decision.taskId}</small>}</header>
              <p>{decisionQuestion(decision.text)}</p>
              <DecisionOptions
                decisionId={decision.id}
                options={decision.options}
                answerDecision={props.answerDecision}
                status={props.status}
                submitting={decision.state === 'submitting'}
              />
              {decision.state === 'submitting' && <small>Sending your answer…</small>}
            </article>
          ))}
        </section>
      )}
      {props.statusBar && <div className="agent-chat-status-bar">{props.statusBar}</div>}
      <Composer key={props.provider} {...props} detail={authVisible ? undefined : props.detail} />
      {authVisible && <AuthPanel {...props} />}
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
    cwd: data.workingDirectory,
    sessionId: data.launchMode === 'resume' ? data.conversationId : undefined,
    permissionMode: data.preferredPermissionMode,
    modelId: data.modelId,
    enabled: !data.dormant,
    onSessionId: (sessionId) => data.onConversationId(id, sessionId),
    onPermissionMode: (modeId) => data.onPermissionModeChange(provider, modeId),
    onModel: (modelId) => data.onModelChange(id, modelId)
  })
  const { status, approval, detail, messages, activities, plan, usage } = conversation
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
    ...conversation,
    // The draft belongs to the node, not to the conversation: it has to outlive resize, collapse
    // and a workspace reload, none of which the ACP session knows anything about.
    draft: data.draft ?? '',
    onDraftChange: (text) => data.onDraftChange(id, text)
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
        <WorktreeBadge data={data} />
        {/* Model, effort and permission pickers live in the composer's toolbar - see
            ComposerToolbar - so the whole picker row reads as one set and the header keeps its
            room for the node's identity. */}
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
        </>
      )}
    </article>
  )
}

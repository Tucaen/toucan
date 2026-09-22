import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
  type KeyboardEvent,
  type RefObject,
  type SyntheticEvent
} from 'react'
import type { AgentCommand } from '../../shared/agent'
import type { WorkspaceFileEntry, WorkspaceFileIndex } from '../../shared/workspace-files'
import type { CompletionToken } from './completion-token'
import { composerTextareaSize } from './composer-autosize'
import { composerKeyAction, type ComposerSendKey } from './composer-keys'
import {
  acceptFileMention,
  acceptedFileMention,
  dismissFileMentionCompletion,
  emptyFileMentionCompletion,
  fileMentionCompletionView,
  fileMentionExclusionNote,
  fileMentionQuery,
  highlightFileMention
} from './file-mention-completion'
import {
  emptyPromptHistory,
  leaveHistory,
  recallNext,
  recallPrevious,
  rememberPrompt,
  seedPromptHistory
} from './prompt-history'
import {
  acceptSlashCommand,
  acceptedSlashCompletion,
  dismissSlashCompletion,
  emptySlashCompletion,
  highlightSlashCommand,
  hoistSlashCommand,
  moveSlashSelection,
  slashCompletionView
} from './slash-command-completion'

/**
 * The prompt editor: text in, accepted prompt out. One hook owns the draft, the caret, the
 * prompt history, both completion pickers and the rules that connect them, and drives the one
 * textarea a `PromptTextarea` renders. The decisions themselves stay in the pure modules this
 * file imports; what lives here is the state they act on and the four rules none of them can own
 * alone: which picker takes the menu, when a picker's memory is forgotten, how the caret is put
 * back after an acceptance, and which accepted command is hoisted on send.
 *
 * It is a hook rather than a pure function because two of its concerns are bound to the real
 * element: the box is measured against `scrollHeight`, and the caret is restored with
 * `setSelectionRange`.
 */

/**
 * What the editor needs to complete a file reference. `root` is the node's resolved
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

export interface PromptEditorOptions {
  /** The draft the node persists; the editor publishes its own edits back through `onDraftChange`. */
  draft: string
  /** Debounced: costs one workspace write per typing pause rather than one per keystroke. */
  onDraftChange?(draft: string): void
  /** The slash commands the session advertises; nothing to complete until it has. */
  commands: AgentCommand[]
  /** Where the `@` picker reads its files from; without one it has nothing to offer. */
  fileMentions?: ComposerFileMentions
  /** Prompts the transcript already shows, so a resumed conversation can be arrowed back through. */
  sentPrompts: readonly string[]
  sendKey: ComposerSendKey
  /** A disabled editor shows its draft but offers no completions and takes no edits. */
  disabled: boolean
  /**
   * Receives the prompt exactly as it will be sent, hoist included. `onPrepared` clears the editor
   * and is the caller's to invoke once the prompt has actually been taken - a refused send keeps
   * the draft.
   */
  submit(event: FormEvent, prompt: string, onPrepared: () => void): void
}

export interface PromptEditorPickerOption {
  key: string
  /** The token the option inserts, shown as the row's own name. */
  label: string
  /** Whatever qualifies the token: a command's argument hint, a folder marker. */
  hint?: string
  description?: string
}

/** The one picker currently open, with everything the completion menu needs to render it. */
export interface PromptEditorPicker {
  /** The listbox id, which the textarea's `aria-controls` also names. */
  id: string
  label: string
  className: string
  options: PromptEditorPickerOption[]
  activeIndex: number
  optionId(index: number): string
  accept(index: number): void
  highlight(index: number): void
  /** Escape: hides this picker for the current token without touching the draft. */
  dismiss(): void
  /** Says what the list is not showing, or null when it shows everything. */
  note: string | null
}

/** The attributes `PromptTextarea` spreads onto its element; the hook owns every one of them. */
export interface PromptTextareaAttributes {
  value: string
  disabled: boolean
  onChange(event: ChangeEvent<HTMLTextAreaElement>): void
  onSelect(event: SyntheticEvent<HTMLTextAreaElement>): void
  onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void
  onBlur(): void
  'aria-expanded': boolean
  'aria-controls': string | undefined
  'aria-activedescendant': string | undefined
}

export interface PromptEditor {
  draft: string
  /** Replaces the draft wholesale, for controls such as dictation that write into the editor. */
  setDraft(value: string): void
  textareaRef: RefObject<HTMLTextAreaElement>
  /** True while there is nothing worth sending. */
  blank: boolean
  textarea: PromptTextareaAttributes
  picker: PromptEditorPicker | null
  /** The form's submit handler: hoists the accepted command, hands the prompt over, clears on success. */
  submit(event: FormEvent): void
}

interface PickerView {
  open: boolean
  token: CompletionToken | null
}

/**
 * One word can hold both tokens (`/fo@o`), so the one starting closer to the caret is the one
 * being typed, and it takes the menu and the keys. Only ever one of them is open.
 * @internal exported for tests
 */
export function activePicker(slash: PickerView, mention: PickerView): 'slash' | 'mention' | null {
  const mentionActive =
    mention.open &&
    mention.token !== null &&
    (!slash.open || slash.token === null || mention.token.start > slash.token.start)
  if (mentionActive) return 'mention'
  return slash.open ? 'slash' : null
}

/**
 * Both completions remember two things per token - what Escape dismissed and what was just
 * accepted - and both must forget them the moment the draft stops offering that token: keeping
 * the memory would silently refuse to complete the next identical token typed in its place. While
 * a token is offered, only the highlight goes back to the top when the token itself changes.
 * Sharing one rule is what keeps the two pickers from drifting apart over it.
 * @internal exported for tests
 */
export function completionMemoryForToken<State>(
  token: CompletionToken | null,
  current: State,
  empty: State,
  resetHighlight: (state: State) => State
): State {
  return token === null ? empty : resetHighlight(current)
}

function useCompletionTokenMemory<State>(
  token: CompletionToken | null,
  empty: State,
  resetHighlight: (state: State) => State,
  setState: (next: State | ((current: State) => State)) => void
): void {
  useEffect(
    () => setState((current) => completionMemoryForToken(token, current, empty, resetHighlight)),
    [token?.query, token?.start]
  )
}

/**
 * Reads the working directory's file index, and only while the editor is actually offering a
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

/** How long the editor waits after the last keystroke before publishing the draft upward. */
const DRAFT_PUBLISH_DELAY_MS = 300

export function usePromptEditor(options: PromptEditorOptions): PromptEditor {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const completionId = useId()
  // The draft is intentionally local to the editor. Publishing every keystroke through the
  // conversation hook rerenders the chat panel, including transcript Markdown, persistence, and
  // decision parsing. None of that work owns the input value.
  const [draft, setDraft] = useState(options.draft)
  const [history, setHistory] = useState(emptyPromptHistory)
  useEffect(() => {
    setHistory((current) => seedPromptHistory(current, options.sentPrompts))
  }, [options.sentPrompts])

  /** The last value this editor handed upward, so the round trip back down is not mistaken
   *  for an outside edit and does not fight what is being typed right now. */
  const publishedDraftRef = useRef(options.draft)
  const onDraftChangeRef = useRef(options.onDraftChange)
  onDraftChangeRef.current = options.onDraftChange

  useEffect(() => {
    if (options.draft === publishedDraftRef.current) return
    publishedDraftRef.current = options.draft
    setDraft(options.draft)
  }, [options.draft])

  // Debounced, so keeping a draft alive across resize/collapse/reload costs one workspace write
  // per typing pause rather than one per keystroke.
  useEffect(() => {
    if (draft === publishedDraftRef.current) return
    const timeout = setTimeout(() => {
      publishedDraftRef.current = draft
      onDraftChangeRef.current?.(draft)
    }, DRAFT_PUBLISH_DELAY_MS)
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
  // real element because only the browser knows how the text actually wrapped. Only the draft can
  // change that measurement: the textarea fills its own row, so the attachment strip and queue
  // chips stacked above it never alter its width.
  useLayoutEffect(() => {
    const element = textareaRef.current
    if (!element) return
    element.style.height = 'auto'
    const { height, scrollable } = composerTextareaSize(element.scrollHeight)
    element.style.height = `${height}px`
    element.style.overflowY = scrollable ? 'auto' : 'hidden'
  }, [draft])

  const applyHistory = (next: { state: typeof history; draft: string }): void => {
    setHistory(next.state)
    setDraft(next.draft)
  }

  // Where the caret sits decides whether a token is being typed at all, so the completions track
  // it rather than guessing from the draft's end - a caret parked mid-token still completes.
  const [caret, setCaret] = useState(0)
  const [slashState, setSlashState] = useState(emptySlashCompletion)
  const [mentionState, setMentionState] = useState(emptyFileMentionCompletion)
  /**
   * The command taken from the menu in this draft - the only one `hoistSlashCommand` will move to
   * the front on send. Deliberately not `slashState.acceptedQuery`: that memory belongs to one
   * token and is spent the moment the caret leaves it, which is exactly when the captain starts
   * typing the command's arguments. This one lives as long as the draft does.
   */
  const [acceptedCommand, setAcceptedCommand] = useState<string | null>(null)
  const editable = options.disabled ? '' : draft
  const slash = slashCompletionView(editable, caret, options.commands, slashState)
  // The workspace listing is read only while a mention is actually being typed, so a conversation
  // nobody points at a file never costs a directory walk.
  const mentionIndex = useFileMentionIndex(options.fileMentions, fileMentionQuery(editable, caret) !== null)
  const mention = fileMentionCompletionView(
    editable,
    caret,
    mentionIndex,
    options.fileMentions?.recent ?? [],
    mentionState
  )
  const active = activePicker(slash, mention)
  useCompletionTokenMemory(
    slash.token,
    emptySlashCompletion,
    (current) => highlightSlashCommand(current, 0),
    setSlashState
  )
  useCompletionTokenMemory(
    mention.token,
    emptyFileMentionCompletion,
    (current) => highlightFileMention(current, 0),
    setMentionState
  )

  // Caret restore: an acceptance rewrites the draft and says where the caret belongs, but the
  // element only shows the new draft after React has rendered it, so the position is parked here
  // and applied once, in the layout effect that follows that render.
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

  const acceptCommand = (command: AgentCommand | undefined): void => {
    if (!slash.token || !command) return
    const next = acceptSlashCommand(draft, caret, slash.token, command)
    setDraft(next.draft)
    setHistory(leaveHistory)
    setSlashState((current) => acceptedSlashCompletion(current, command))
    setAcceptedCommand(command.name)
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

  const highlightSlash = (index: number): void => setSlashState((current) => highlightSlashCommand(current, index))
  const highlightMention = (index: number): void => setMentionState((current) => highlightFileMention(current, index))
  const dismissSlash = (): void => setSlashState((current) => dismissSlashCompletion(current, slash.token))
  const dismissMention = (): void => setMentionState((current) => dismissFileMentionCompletion(current, mention.token))

  const optionId = (index: number): string => `${completionId}-${index}`
  const picker: PromptEditorPicker | null =
    active === 'mention'
      ? {
          id: completionId,
          label: 'Workspace files',
          className: 'file-mention-menu',
          options: mention.matches.map((entry) => ({
            key: entry.path,
            label: entry.directory ? `${entry.path}/` : entry.path,
            hint: options.fileMentions?.recent.includes(entry.path) ? 'already read' : undefined
          })),
          activeIndex: mention.activeIndex,
          optionId,
          accept: (index) => acceptMention(mention.matches[index]),
          highlight: highlightMention,
          dismiss: dismissMention,
          note: fileMentionExclusionNote(mentionIndex)
        }
      : active === 'slash'
        ? {
            id: completionId,
            label: 'Slash commands',
            className: 'slash-command-menu',
            options: slash.matches.map((command) => ({
              key: command.name,
              label: `/${command.name}`,
              hint: command.input?.hint,
              description: command.description
            })),
            activeIndex: slash.activeIndex,
            optionId,
            accept: (index) => acceptCommand(slash.matches[index]),
            highlight: highlightSlash,
            dismiss: dismissSlash,
            note: null
          }
        : null

  /** Returns true when the picker has claimed the key press, so the editor's own bindings stay out of it. */
  const handlePickerKey = (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!picker || event.nativeEvent.isComposing) return false
    // Alt+Arrow belongs to the canvas layout even while the textarea and its picker are focused.
    if (!event.altKey && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault()
      picker.highlight(
        moveSlashSelection(picker.activeIndex, picker.options.length, event.key === 'ArrowDown' ? 1 : -1)
      )
      return true
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      picker.dismiss()
      return true
    }
    // Shift/Alt+Enter still means "newline" here; only a plain accept keystroke picks an entry.
    if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey && !event.altKey)) {
      event.preventDefault()
      picker.accept(picker.activeIndex)
      return true
    }
    return false
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (handlePickerKey(event)) return
    const action = composerKeyAction(
      {
        key: event.key,
        shiftKey: event.shiftKey,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        altKey: event.altKey,
        isComposing: event.nativeEvent.isComposing
      },
      { sendKey: options.sendKey, draft, historyActive: history.index !== null }
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
  }

  const submit = (event: FormEvent): void => {
    // A command taken from the menu only runs if it opens the prompt, so it moves to the front
    // here - what is sent is what is remembered and echoed, hoist included. The acceptance is
    // spent with the draft it belonged to, so the next prompt starts as prose.
    const sent = hoistSlashCommand(draft, options.commands, acceptedCommand)
    options.submit(event, sent, () => {
      setDraft('')
      setAcceptedCommand(null)
      setHistory((current) => rememberPrompt(current, sent))
    })
  }

  return {
    draft,
    setDraft,
    textareaRef,
    blank: draft.trim() === '',
    picker,
    submit,
    textarea: {
      value: draft,
      disabled: options.disabled,
      onChange: (event) => {
        setDraft(event.target.value)
        setCaret(event.target.selectionStart ?? event.target.value.length)
        setHistory(leaveHistory)
      },
      onSelect: (event) => setCaret(event.currentTarget.selectionStart ?? 0),
      onKeyDown,
      // The menu is a portal, so focus leaving the editor entirely (not into the menu, whose
      // mousedown is suppressed) means the captain has moved on and neither picker should keep
      // hovering.
      onBlur: () => {
        dismissSlash()
        dismissMention()
      },
      'aria-expanded': picker !== null,
      'aria-controls': picker ? completionId : undefined,
      'aria-activedescendant': picker ? optionId(picker.activeIndex) : undefined
    }
  }
}

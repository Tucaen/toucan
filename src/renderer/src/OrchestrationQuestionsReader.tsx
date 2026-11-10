import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent
} from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { layoutKeyAction } from './canvas-layout'
import { NodeFitContext } from './node-fit-context'
import NodeFitAction from './NodeFitAction'
import {
  OTHER_ANSWER_LIMIT,
  PINNED_QUESTION_FORM,
  pinnedQuestionDecision,
  pinnedQuestionNote
} from '../../shared/orchestration-question-answer'
import MarkdownMessage from './MarkdownMessage'
import {
  clampReaderRect,
  defaultReaderRect,
  moveReaderRect,
  recallReaderRect,
  reflowReaderRect,
  rememberReaderRect,
  resizeReaderRect,
  snapReaderRect,
  toggleReaderFit,
  type ReaderRect,
  type ReaderSnap
} from './orchestration-reader-geometry'
import StructuredDecisionPanel from './StructuredDecisionPanel'
import type { OrchestrationQuestions } from './useOrchestrationQuestions'

function viewport(): { width: number; height: number } {
  return { width: window.innerWidth, height: window.innerHeight }
}

/** The element a node's fullscreen fills: the canvas between the sidebar, the top bar and a docked panel. */
function canvasElement(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.canvas-region')
}

/** Where Alt+Arrow and the fit button arrange the window; the whole viewport only while there is no canvas. */
function canvasBounds(): ReaderRect {
  const rect = canvasElement()?.getBoundingClientRect()
  return rect
    ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
    : { left: 0, top: 0, ...viewport() }
}

/** Into the shown question's answer field, else the window itself; the question still reads from its start. */
function focusShownQuestion(reader: HTMLElement): void {
  const field = reader.querySelector<HTMLElement>(
    '.orchestration-question:not([hidden]) textarea, .orchestration-question:not([hidden]) input'
  )
  ;(field ?? reader).focus({ preventScroll: true })
}

/**
 * The tab to show once the open questions changed: the selected one while it is still open, else
 * the next one after it, else the one before it - as a closed browser tab hands over to a
 * neighbour - and the first one when there was no selection. A question that arrives leaves the
 * selection alone, so an answer being typed is never pulled away.
 * @internal exported for tests
 */
export function questionTabAfterChange(
  previous: readonly string[],
  current: readonly string[],
  selected: string | undefined
): string | undefined {
  if (selected !== undefined && current.includes(selected)) return selected
  const index = selected === undefined ? -1 : previous.indexOf(selected)
  if (index >= 0) {
    const neighbour = [...previous.slice(index + 1), ...previous.slice(0, index).reverse()].find((id) =>
      current.includes(id)
    )
    if (neighbour !== undefined) return neighbour
  }
  return current[0]
}

/**
 * Every open question at real screen size, as a floating window rather than a modal: the canvas and
 * its nodes stay usable beside it, so a long question can be read while its answer is typed. It
 * portals to `document.body` because the node's own subtree is scaled by the canvas zoom (and, on a
 * worktree canvas, by two of them) and clipped by the node. Escape closes it only while focus is
 * inside; a click elsewhere leaves it open. Its title bar moves it, its bottom-right corner resizes
 * it without limit, Alt+Arrow and the header's fit button arrange it like a node on the canvas, and
 * the rectangle is remembered per orchestrator node for the app session. Each question is a tab
 * that gets the whole window below the tab row.
 */
export default function OrchestrationQuestionsReader({
  nodeId,
  questions,
  pending,
  formKey,
  resolve,
  accent,
  answers,
  onAnswerChange,
  focusSignal,
  onClose
}: OrchestrationQuestions & {
  nodeId: string
  /** The node's accent, copied in because the portal leaves the node's CSS variables behind. */
  accent?: string
  /** Typed answers by question id; owned by the caller so closing the window never loses one. */
  answers: Readonly<Record<string, string>>
  onAnswerChange(questionId: string, text: string): void
  /** Bumped by the caller to bring the window forward: focus moves into it again. */
  focusSignal: number
  onClose(): void
}): JSX.Element {
  const baseId = useId()
  const titleId = `${baseId}-title`
  const root = useRef<HTMLDivElement>(null)
  const [rect, setRect] = useState<ReaderRect>(() =>
    clampReaderRect(recallReaderRect(nodeId) ?? defaultReaderRect(viewport()), viewport())
  )
  // Where the window is arranged (halves, quarters, maximised) and where it returns to.
  const [snap, setSnap] = useState<ReaderSnap | null>(null)
  const latest = useRef(rect)
  latest.current = rect
  const latestSnap = useRef(snap)
  latestSnap.current = snap

  const ids = questions.map((question) => question.id)
  const idsKey = ids.join('\n')
  // The selected tab and the question ids it was chosen among. A changed list re-selects while
  // rendering, so the next change is measured from the tab now shown.
  const [tabs, setTabs] = useState<{ key: string; ids: readonly string[]; selected: string | undefined }>({
    key: '',
    ids: [],
    selected: undefined
  })
  let activeId = tabs.selected
  if (tabs.key !== idsKey) {
    activeId = questionTabAfterChange(tabs.ids, ids, tabs.selected)
    setTabs({ key: idsKey, ids, selected: activeId })
  }
  const select = (questionId: string): void => setTabs((current) => ({ ...current, selected: questionId }))

  const arrange = (next: { rect: ReaderRect; snap: ReaderSnap | null }): void => {
    setRect(next.rect)
    setSnap(next.snap)
  }

  useEffect(() => {
    rememberReaderRect(nodeId, rect)
  }, [nodeId, rect])

  // A smaller window must not strand the reader off screen, and an arranged one follows the canvas
  // when the window, the sidebar or a docked panel changes its size.
  useEffect(() => {
    const reflow = (): void =>
      setRect((current) => reflowReaderRect(current, latestSnap.current, canvasBounds(), viewport()))
    window.addEventListener('resize', reflow)
    const canvas = canvasElement()
    const observer = canvas && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(reflow) : undefined
    if (canvas) observer?.observe(canvas)
    return () => {
      window.removeEventListener('resize', reflow)
      observer?.disconnect()
    }
  }, [])

  // On open and whenever the badge asks for it again.
  useEffect(() => {
    if (root.current) focusShownQuestion(root.current)
  }, [focusSignal])

  // Whether focus belongs to the window: given by focus moving in, taken by focus moving elsewhere or
  // a press outside, but not by focus merely being dropped. Answering a question disables its
  // focused Send, Erledigt or Submit button and then removes or hides it, and the browser drops focus
  // to the page, where Alt+Arrow and typing reach the canvas; focus goes on to the shown question.
  const ownsFocus = useRef(false)
  useEffect(() => {
    const onFocusIn = (event: FocusEvent): void => {
      ownsFocus.current = !!root.current?.contains(event.target as Node)
    }
    const onPress = (event: MouseEvent): void => {
      if (!root.current?.contains(event.target as Node)) ownsFocus.current = false
    }
    document.addEventListener('focusin', onFocusIn)
    document.addEventListener('mousedown', onPress, true)
    return () => {
      document.removeEventListener('focusin', onFocusIn)
      document.removeEventListener('mousedown', onPress, true)
    }
  }, [])
  useLayoutEffect(() => {
    const element = root.current
    if (!element || !ownsFocus.current) return
    const focused = document.activeElement
    const dropped =
      !focused ||
      focused === document.body ||
      (element.contains(focused) && (focused.matches(':disabled') || !!focused.closest('[hidden]')))
    if (dropped) focusShownQuestion(element)
  })

  const endGesture = useRef<(() => void) | undefined>(undefined)
  useEffect(() => () => endGesture.current?.(), [])

  /** One drag gesture: the mouse follows on the document, so a fast move never loses the window. */
  const track = (event: ReactMouseEvent, next: (start: ReaderRect, dx: number, dy: number) => ReaderRect): void => {
    if (event.button !== 0) return
    event.preventDefault()
    // Preventing the default also keeps the focus where it was, outside the window, where Alt+Arrow
    // would reach the canvas instead; grabbing the window is choosing it.
    const element = root.current
    if (element && !element.contains(document.activeElement)) element.focus({ preventScroll: true })
    const start = latest.current
    const originX = event.clientX
    const originY = event.clientY
    // Moving or resizing by hand makes the window the user's again, as it does for a snapped node.
    const onMove = (move: MouseEvent): void => {
      setSnap(null)
      setRect(next(start, move.clientX - originX, move.clientY - originY))
    }
    const onUp = (): void => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      endGesture.current = undefined
    }
    endGesture.current?.()
    endGesture.current = onUp
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  const tabId = (questionId: string): string => `${baseId}-tab-${questionId}`
  const panelId = (questionId: string): string => `${baseId}-panel-${questionId}`

  /** Left and Right on the tab row step through the questions and wrap, as a tab list does. */
  const stepTab = (event: ReactKeyboardEvent, questionId: string): void => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
    if (step === 0 || ids.length === 0) return
    event.preventDefault()
    const next = ids[(ids.indexOf(questionId) + step + ids.length) % ids.length]
    select(next)
    document.getElementById(tabId(next))?.focus()
  }

  return createPortal(
    <div
      ref={root}
      className="orchestration-reader nodrag nopan nowheel"
      role="dialog"
      aria-labelledby={titleId}
      tabIndex={-1}
      style={{
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
        ...(accent ? { '--node-accent': accent } : {})
      }}
      // The window is a React child of the node: nothing clicked or typed in it may select the node,
      // start its drag or reach a canvas shortcut.
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        event.stopPropagation()
        if (event.key === 'Escape') onClose()
        // Every field in the window is where an answer is typed, as the composer is a node's, so
        // Alt+Arrow arranges the window from any of them - the decision panel's one-line Other field
        // too, which is where opening the window puts the focus. The canvas leaves a one-line input
        // its Alt+Arrow; here that would leave the shortcut dead on open.
        const action = layoutKeyAction(event.nativeEvent, { editingText: false, editingTextarea: false })
        if (action.kind !== 'snap') return
        event.preventDefault()
        arrange(snapReaderRect(latest.current, latestSnap.current, action.arrow, canvasBounds()))
      }}
    >
      <header
        className="orchestration-reader-header"
        onMouseDown={(event) => {
          if ((event.target as HTMLElement).closest('button')) return
          track(event, (start, dx, dy) => moveReaderRect(start, dx, dy, viewport()))
        }}
      >
        <h2 id={titleId}>Offene Fragen ({questions.length})</h2>
        <NodeFitContext.Provider
          value={() => arrange(toggleReaderFit(latest.current, latestSnap.current, canvasBounds()))}
        >
          <NodeFitAction nodeId={nodeId} fitted={snap?.h === 'full' && snap.v === 'full'} />
        </NodeFitContext.Provider>
        <button type="button" className="orchestration-reader-close" aria-label="Schließen" onClick={onClose}>
          <X aria-hidden="true" />
        </button>
      </header>
      <div className="orchestration-reader-tabs">
        <div className="orchestration-reader-tablist" role="tablist" aria-labelledby={titleId}>
          {questions.map((question) => {
            const active = question.id === activeId
            return (
              <button
                key={question.id}
                id={tabId(question.id)}
                type="button"
                role="tab"
                className="orchestration-reader-tab"
                aria-selected={active}
                aria-controls={panelId(question.id)}
                tabIndex={active ? 0 : -1}
                onClick={() => select(question.id)}
                onKeyDown={(event) => stepTab(event, question.id)}
              >
                {question.id}
                {question.ticketId && <span>{` #${question.ticketId}`}</span>}
              </button>
            )
          })}
        </div>
        {activeId !== undefined && (
          <span className="orchestration-question-actions">
            <button
              type="button"
              title={`${activeId} als erledigt markieren`}
              disabled={pending === activeId}
              onClick={() => void resolve(activeId)}
            >
              Erledigt
            </button>
          </span>
        )}
      </div>
      {questions.map((question) => {
        const decision = pinnedQuestionDecision(question)
        const text = answers[question.id] ?? ''
        const send = (): void => {
          if (text.trim() === '' || pending === question.id) return
          void resolve(question.id, pinnedQuestionNote({ [PINNED_QUESTION_FORM.other]: text }))
        }
        // Every question stays mounted, so a half-filled decision panel survives switching tabs.
        return (
          <section
            key={question.id}
            id={panelId(question.id)}
            className="orchestration-question"
            role="tabpanel"
            aria-labelledby={tabId(question.id)}
            data-question-id={question.id}
            hidden={question.id !== activeId}
          >
            <div className="orchestration-question-body">
              <MarkdownMessage text={question.markdown} />
              {decision && (
                <StructuredDecisionPanel
                  key={formKey}
                  decisionRequest={decision}
                  resolveElicitation={(_requestId, content) => void resolve(question.id, pinnedQuestionNote(content))}
                />
              )}
            </div>
            {!decision && (
              <div className="orchestration-question-answer">
                <textarea
                  aria-label={`Antwort auf ${question.id}`}
                  placeholder="Antwort schreiben … (Strg/Cmd+Enter sendet)"
                  rows={3}
                  maxLength={OTHER_ANSWER_LIMIT}
                  value={text}
                  onChange={(event) => onAnswerChange(question.id, event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                      event.preventDefault()
                      send()
                    }
                  }}
                />
                <button type="button" disabled={text.trim() === '' || pending === question.id} onClick={send}>
                  Senden
                </button>
              </div>
            )}
          </section>
        )
      })}
      <div
        className="orchestration-reader-resize"
        aria-hidden="true"
        onMouseDown={(event) => track(event, (start, dx, dy) => resizeReaderRect(start, dx, dy))}
      />
    </div>,
    document.body
  )
}

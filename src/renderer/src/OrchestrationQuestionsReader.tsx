import { useEffect, useId, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
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

/**
 * Every open question at real screen size, as a floating window rather than a modal: the canvas and
 * its nodes stay usable beside it, so a long question can be read while its answer is typed. It
 * portals to `document.body` because the node's own subtree is scaled by the canvas zoom (and, on a
 * worktree canvas, by two of them) and clipped by the node. Escape closes it only while focus is
 * inside; a click elsewhere leaves it open. Its title bar moves it, its bottom-right corner resizes
 * it without limit, Alt+Arrow and the header's fit button arrange it like a node on the canvas, and
 * the rectangle is remembered per orchestrator node for the app session.
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
  const titleId = useId()
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

  const arrange = (next: { rect: ReaderRect; snap: ReaderSnap | null }): void => {
    setRect(next.rect)
    setSnap(next.snap)
  }

  useEffect(() => {
    rememberReaderRect(nodeId, rect)
  }, [nodeId, rect])

  // A smaller window must not strand the reader off screen.
  useEffect(() => {
    const keepInside = (): void => setRect((current) => reflowReaderRect(current, latestSnap.current, viewport()))
    window.addEventListener('resize', keepInside)
    return () => window.removeEventListener('resize', keepInside)
  }, [])

  // On open and whenever the badge asks for it again: into the first answer field, else the window.
  useEffect(() => {
    const element = root.current
    if (!element) return
    const field = element.querySelector<HTMLElement>('textarea, input')
    ;(field ?? element).focus()
  }, [focusSignal])

  const endGesture = useRef<(() => void) | undefined>(undefined)
  useEffect(() => () => endGesture.current?.(), [])

  /** One drag gesture: the mouse follows on the document, so a fast move never loses the window. */
  const track = (event: ReactMouseEvent, next: (start: ReaderRect, dx: number, dy: number) => ReaderRect): void => {
    if (event.button !== 0) return
    event.preventDefault()
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

  const single = questions.length === 1

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
        const target = event.target as HTMLElement
        const action = layoutKeyAction(event.nativeEvent, {
          editingText: target.matches('input, textarea, select, [contenteditable]'),
          editingTextarea: target.tagName === 'TEXTAREA'
        })
        if (action.kind !== 'snap') return
        event.preventDefault()
        arrange(snapReaderRect(latest.current, latestSnap.current, action.arrow, viewport()))
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
        <NodeFitContext.Provider value={() => arrange(toggleReaderFit(latest.current, latestSnap.current, viewport()))}>
          <NodeFitAction nodeId={nodeId} fitted={snap?.h === 'full' && snap.v === 'full'} />
        </NodeFitContext.Provider>
        <button type="button" className="orchestration-reader-close" aria-label="Schließen" onClick={onClose}>
          <X aria-hidden="true" />
        </button>
      </header>
      <ul className="orchestration-reader-list" data-single={single ? 'true' : undefined}>
        {questions.map((question) => {
          const decision = pinnedQuestionDecision(question)
          const text = answers[question.id] ?? ''
          const send = (): void => {
            if (text.trim() === '' || pending === question.id) return
            void resolve(question.id, pinnedQuestionNote({ [PINNED_QUESTION_FORM.other]: text }))
          }
          return (
            <li key={question.id} className="orchestration-question" data-question-id={question.id}>
              <div className="orchestration-question-head">
                <strong>{question.id}</strong>
                {question.ticketId && <span>#{question.ticketId}</span>}
                <span className="orchestration-question-actions">
                  <button type="button" disabled={pending === question.id} onClick={() => void resolve(question.id)}>
                    Erledigt
                  </button>
                </span>
              </div>
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
            </li>
          )
        })}
      </ul>
      <div
        className="orchestration-reader-resize"
        aria-hidden="true"
        onMouseDown={(event) => track(event, (start, dx, dy) => resizeReaderRect(start, dx, dy))}
      />
    </div>,
    document.body
  )
}

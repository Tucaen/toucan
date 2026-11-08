import { useId, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { pinnedQuestionDecision, pinnedQuestionNote } from '../../shared/orchestration-question-answer'
import MarkdownMessage from './MarkdownMessage'
import { ModalDialog } from './ModalDialog'
import StructuredDecisionPanel from './StructuredDecisionPanel'
import type { OrchestrationQuestions } from './useOrchestrationQuestions'

/**
 * Every open question at real screen size. It portals to `document.body` because the node's own
 * subtree is scaled by the canvas zoom (and, on a worktree canvas, by two of them) and clipped by
 * the node; the reader must not depend on either. Escape and a click on the backdrop close it.
 */
export default function OrchestrationQuestionsReader({
  questions,
  pending,
  formKey,
  resolve,
  accent,
  onAnswer,
  onClose
}: OrchestrationQuestions & {
  /** The node's accent, copied in because the portal leaves the node's CSS variables behind. */
  accent?: string
  /** `Antworten`: the caller leaves the reader and puts the reference in the composer. */
  onAnswer(questionId: string): void
  onClose(): void
}): JSX.Element {
  const titleId = useId()
  return createPortal(
    <ModalDialog labelledBy={titleId} onClose={onClose} className="orchestration-reader-overlay">
      <div
        className="orchestration-reader-backdrop nodrag nopan nowheel"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) onClose()
        }}
      >
        <div
          className="orchestration-reader"
          style={accent ? ({ '--node-accent': accent } as CSSProperties) : undefined}
        >
          <header className="orchestration-reader-header">
            <h2 id={titleId}>Offene Fragen ({questions.length})</h2>
            <span className="orchestration-reader-hint">Esc schließt</span>
            <button type="button" className="orchestration-reader-close" aria-label="Schließen" onClick={onClose}>
              <X aria-hidden="true" />
            </button>
          </header>
          <ul className="orchestration-reader-list">
            {questions.map((question) => {
              const decision = pinnedQuestionDecision(question)
              return (
                <li key={question.id} className="orchestration-question" data-question-id={question.id}>
                  <div className="orchestration-question-head">
                    <strong>{question.id}</strong>
                    {question.ticketId && <span>#{question.ticketId}</span>}
                    <span className="orchestration-question-actions">
                      <button type="button" onClick={() => onAnswer(question.id)}>
                        Antworten
                      </button>
                      <button
                        type="button"
                        disabled={pending === question.id}
                        onClick={() => void resolve(question.id)}
                      >
                        Erledigt
                      </button>
                    </span>
                  </div>
                  <MarkdownMessage text={question.markdown} />
                  {decision && (
                    <StructuredDecisionPanel
                      key={formKey}
                      decisionRequest={decision}
                      resolveElicitation={(_requestId, content) =>
                        void resolve(question.id, pinnedQuestionNote(content))
                      }
                    />
                  )}
                </li>
              )
            })}
          </ul>
        </div>
      </div>
    </ModalDialog>,
    document.body
  )
}

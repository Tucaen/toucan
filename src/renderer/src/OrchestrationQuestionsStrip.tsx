import { useEffect, useRef, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import type { OrchestrationControlRequest } from '../../shared/ticket-session-spawn'
import OrchestrationQuestionsReader from './OrchestrationQuestionsReader'
import { useOrchestrationQuestions } from './useOrchestrationQuestions'

/**
 * The composer text `Antworten` leaves behind: the existing draft is kept, the reference starts a new line.
 * @internal exported for tests
 */
export function draftAnsweringQuestion(draft: string, questionId: string): string {
  const prefix = `Zu ${questionId}: `
  if (draft.trim() === '') return prefix
  return `${draft}${draft.endsWith('\n') ? '' : '\n'}${prefix}`
}

/**
 * A question flattened to one plain-text row: links and emphasis lose their markup, so the
 * badge shows words instead of syntax.
 * @internal exported for tests
 */
export function questionPreview(id: string, markdown: string): string {
  const text = markdown
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^[#>\s]+/gm, '')
    .replace(/[`*]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return text ? `${id}: ${text}` : id
}

/**
 * The orchestrator node's pinned open questions (#3): each is stored once in the record. The node
 * itself only carries a one-row badge - the transcript is scaled by the canvas zoom and clipped by
 * the node, so the questions are read and answered in a reader outside it. Hidden when nothing is open.
 */
export default function OrchestrationQuestionsStrip({
  request,
  draft,
  onDraftChange
}: {
  request: OrchestrationControlRequest
  draft: string
  onDraftChange(draft: string): void
}): JSX.Element | null {
  const questions = useOrchestrationQuestions(request)
  const [open, setOpen] = useState(false)
  const [accent, setAccent] = useState<string | undefined>(undefined)
  const band = useRef<HTMLElement>(null)
  const count = questions.questions.length

  // A new question after the last one was answered must not pop the reader open by itself.
  useEffect(() => {
    if (count === 0) setOpen(false)
  }, [count])

  if (count === 0) return null
  const [first] = questions.questions

  return (
    <section ref={band} className="orchestration-questions nodrag" aria-label="Offene Fragen">
      <button
        type="button"
        className="orchestration-questions-badge"
        aria-haspopup="dialog"
        onClick={() => {
          const value = band.current ? getComputedStyle(band.current).getPropertyValue('--node-accent').trim() : ''
          setAccent(value || undefined)
          setOpen(true)
        }}
      >
        <span className="orchestration-questions-count">{count}</span>
        <span className="orchestration-questions-label">{count === 1 ? 'Offene Frage' : 'Offene Fragen'}</span>
        <span className="orchestration-questions-preview">{questionPreview(first.id, first.markdown)}</span>
        <span className="orchestration-questions-open">
          Öffnen
          <ChevronRight aria-hidden="true" />
        </span>
      </button>
      {open && (
        <OrchestrationQuestionsReader
          {...questions}
          accent={accent}
          onAnswer={(questionId) => {
            onDraftChange(draftAnsweringQuestion(draft, questionId))
            setOpen(false)
          }}
          onClose={() => setOpen(false)}
        />
      )}
    </section>
  )
}

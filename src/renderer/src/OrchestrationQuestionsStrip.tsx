import { useEffect, useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import type { OrchestrationControlRequest, OrchestrationControlState } from '../../shared/ticket-session-spawn'
import { pinnedQuestionDecision, pinnedQuestionNote } from '../../shared/orchestration-question-answer'
import MarkdownMessage from './MarkdownMessage'
import StructuredDecisionPanel from './StructuredDecisionPanel'

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
 * The orchestrator node's pinned open questions (#3): each is stored once in the record and shown
 * here verbatim, outside the scrolling transcript, so the human never scrolls back to the first
 * ask to find its links. Hidden when nothing is open.
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
  const [state, setState] = useState<OrchestrationControlState | null>(null)
  const [collapsed, setCollapsed] = useState(false)
  const [pending, setPending] = useState<string | undefined>(undefined)
  // Bumped when a resolve fails, so a decision panel that locked itself on submit starts afresh.
  const [formKey, setFormKey] = useState(0)
  const { provider, conversationId, nodeId } = request
  const identity = `${provider}:${conversationId}`

  useEffect(() => {
    let current = true
    void window.orchestratorApi
      .orchestrationState({ provider, conversationId, nodeId })
      .then((next) => {
        if (current) setState(next)
      })
      .catch(() => undefined)
    const unsubscribe = window.orchestratorApi.onOrchestrationState((next) => {
      if (current && `${next.provider}:${next.conversationId}` === identity) setState(next)
    })
    return () => {
      current = false
      unsubscribe()
    }
  }, [conversationId, identity, nodeId, provider])

  const questions = state?.openQuestions ?? []
  if (questions.length === 0) return null

  const resolve = async (questionId: string, note?: string): Promise<void> => {
    setPending(questionId)
    try {
      const next = await window.orchestratorApi.resolveQuestion({
        provider,
        conversationId,
        nodeId,
        questionId,
        ...(note !== undefined ? { note } : {})
      })
      if (next) setState(next)
      else setFormKey((count) => count + 1)
    } catch {
      // The durable record stays authoritative; the pushed state or a remount shows the truth.
      setFormKey((count) => count + 1)
    } finally {
      setPending(undefined)
    }
  }

  return (
    <section className="orchestration-questions nodrag" aria-label="Offene Fragen">
      <button
        type="button"
        className="orchestration-questions-toggle"
        aria-expanded={!collapsed}
        onClick={() => setCollapsed((value) => !value)}
      >
        {collapsed ? <ChevronRight aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}
        Offene Fragen ({questions.length})
      </button>
      {!collapsed && (
        <ul className="orchestration-questions-list">
          {questions.map((question) => {
            const decision = pinnedQuestionDecision(question)
            return (
              <li key={question.id} className="orchestration-question" data-question-id={question.id}>
                <div className="orchestration-question-head">
                  <strong>{question.id}</strong>
                  {question.ticketId && <span>#{question.ticketId}</span>}
                  <span className="orchestration-question-actions">
                    <button type="button" onClick={() => onDraftChange(draftAnsweringQuestion(draft, question.id))}>
                      Antworten
                    </button>
                    <button type="button" disabled={pending === question.id} onClick={() => void resolve(question.id)}>
                      Erledigt
                    </button>
                  </span>
                </div>
                <MarkdownMessage text={question.markdown} />
                {decision && (
                  <StructuredDecisionPanel
                    key={formKey}
                    decisionRequest={decision}
                    resolveElicitation={(_requestId, content) => void resolve(question.id, pinnedQuestionNote(content))}
                  />
                )}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

import type { AgentDecisionRequest, AgentDecisionResponseContent } from './agent'
import type { OrchestrationQuestion } from './orchestration'

/**
 * A pinned question that carries options is shown through the same decision form a ticket session
 * shows its own pending question with, on the desktop (`StructuredDecisionPanel`) and the phone
 * (`DecisionCard`). These two functions are the whole seam: the question becomes the one-question
 * request those forms render, and what the human filled in becomes the note that resolves the
 * question, which is how the answer reaches the orchestrator (`questionResolvedPrompt`).
 */

/** The id of the one form question, and of its "Other" field, in a pinned question's request. */
export const PINNED_QUESTION_FORM = { question: 'answer', other: 'other' } as const

/** The longest "Other" text kept in a note; a phone's resolve body is capped a little above it. */
const OTHER_ANSWER_LIMIT = 3500

/** The form request for a pinned question, or `undefined` for a plain-text one. */
export function pinnedQuestionDecision(
  question: Pick<OrchestrationQuestion, 'id' | 'ticketId' | 'options' | 'multiSelect'>
): AgentDecisionRequest | undefined {
  if (!question.options || question.options.length === 0) return undefined
  return {
    id: `pinned:${question.id}`,
    message: question.ticketId ? `${question.id} · ticket #${question.ticketId}` : question.id,
    questions: [
      {
        id: PINNED_QUESTION_FORM.question,
        question: 'Your answer',
        options: question.options.map((option) => ({
          value: option.label,
          label: option.label,
          ...(option.description ? { description: option.description } : {})
        })),
        input: 'select',
        multiSelect: question.multiSelect === true,
        required: true,
        customAnswerId: PINNED_QUESTION_FORM.other,
        customAnswerHint: 'Or write your own answer'
      }
    ]
  }
}

/**
 * The note a filled-in form resolves its pinned question with. `undefined` content is the form's
 * Skip: the question is resolved, and the orchestrator is told it was left unanswered.
 */
export function pinnedQuestionNote(content?: AgentDecisionResponseContent): string {
  if (!content) return 'Skipped without an answer.'
  const chosen = content[PINNED_QUESTION_FORM.question]
  const picked = (Array.isArray(chosen) ? chosen : typeof chosen === 'string' && chosen !== '' ? [chosen] : []).map(
    String
  )
  const otherValue = content[PINNED_QUESTION_FORM.other]
  const other = typeof otherValue === 'string' ? otherValue.trim().slice(0, OTHER_ANSWER_LIMIT) : ''
  if (picked.length === 0) return other === '' ? 'Skipped without an answer.' : `Answer: ${other}`
  return other === '' ? `Answer: ${picked.join(', ')}` : `Answer: ${picked.join(', ')} (note: ${other})`
}

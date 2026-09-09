/**
 * The structured decision panel's form rules, kept apart from its markup so what counts as an
 * answered question, when the form may submit, and where a tab key lands are testable without
 * rendering the panel (`StructuredDecisionPanel.tsx` is the one consumer). The phone applies its
 * own variant of these rules in `mobile/src/decision-answers.ts`; a rule change that affects what
 * an answer *means* must land in both.
 */
import type { AgentDecisionQuestion, AgentDecisionResponseContent } from '../../shared/agent'

/**
 * A question is answered by its own value or by text in its "Other" field. A custom answer must
 * carry non-whitespace text - an empty string in either place is an untouched control, not an
 * answer - while a multi-select needs at least one option and a boolean counts either way.
 */
export function decisionAnswered(question: AgentDecisionQuestion, answers: AgentDecisionResponseContent): boolean {
  const custom = question.customAnswerId ? answers[question.customAnswerId] : undefined
  const selected = answers[question.id]
  return (
    (typeof custom === 'string' && custom.trim() !== '') ||
    (typeof selected === 'string'
      ? selected !== ''
      : Array.isArray(selected)
        ? selected.length > 0
        : selected !== undefined)
  )
}

export function allRequiredAnswered(
  questions: readonly AgentDecisionQuestion[],
  answers: AgentDecisionResponseContent
): boolean {
  return questions.every((question) => !question.required || decisionAnswered(question, answers))
}

export function requiredAnswersRemaining(
  questions: readonly AgentDecisionQuestion[],
  answers: AgentDecisionResponseContent
): number {
  return questions.filter((question) => question.required && !decisionAnswered(question, answers)).length
}

/**
 * Where a key press on the question tab list lands, following the roving-tabindex convention:
 * arrows wrap around the ends, Home/End jump to them, and every other key is not navigation.
 */
export function decisionTabTarget(key: string, index: number, count: number): number | null {
  const last = count - 1
  switch (key) {
    case 'ArrowRight':
      return index === last ? 0 : index + 1
    case 'ArrowLeft':
      return index === 0 ? last : index - 1
    case 'Home':
      return 0
    case 'End':
      return last
    default:
      return null
  }
}

/**
 * Folds a clicked option into the answers. Choosing an option always clears the question's
 * "Other" text - the two are mutually exclusive ways of answering one question - and a
 * multi-select toggles the value in and out while a single select replaces it.
 */
export function withChosenOption(
  question: AgentDecisionQuestion,
  answers: AgentDecisionResponseContent,
  value: string
): AgentDecisionResponseContent {
  const next = { ...answers }
  if (question.customAnswerId) delete next[question.customAnswerId]
  if (!question.multiSelect) return { ...next, [question.id]: value }
  const selected = Array.isArray(answers[question.id]) ? (answers[question.id] as string[]) : []
  return {
    ...next,
    [question.id]: selected.includes(value) ? selected.filter((item) => item !== value) : [...selected, value]
  }
}

/**
 * Folds typed "Other" text into the answers. Text with substance displaces the chosen option
 * (the same mutual exclusion as `withChosenOption`, from the other side); clearing the field
 * removes the custom answer without resurrecting anything.
 */
export function withCustomAnswer(
  question: AgentDecisionQuestion,
  answers: AgentDecisionResponseContent,
  value: string
): AgentDecisionResponseContent {
  if (!question.customAnswerId) return answers
  const next = { ...answers }
  if (value.trim()) {
    delete next[question.id]
    next[question.customAnswerId] = value
  } else {
    delete next[question.customAnswerId]
  }
  return next
}

/** Folds a typed number in, treating a cleared field as "no answer" rather than zero. */
export function withNumberAnswer(
  question: AgentDecisionQuestion,
  answers: AgentDecisionResponseContent,
  raw: string
): AgentDecisionResponseContent {
  const next = { ...answers }
  if (raw === '') delete next[question.id]
  else next[question.id] = Number(raw)
  return next
}

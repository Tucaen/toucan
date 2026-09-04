import type { AgentDecisionQuestion, AgentDecisionRequest, AgentDecisionResponseContent } from '../../src/shared/agent'
import { decisionContentProblem } from '../../src/shared/remote-chat'

/**
 * Filling in one structured question set, as data. Everything a form card decides - what counts as
 * answered, what a tap on an option does to a multi-select, whether "Other" outranks a chosen
 * value, and whether the whole set may be submitted yet - lives here, so the phone's rules can be
 * tested without a DOM and provably match the desktop's reading of the same request.
 *
 * The rules that are not obvious, and are the desktop's:
 *
 * - A question with a `customAnswerId` carries its free-text answer in a *sibling* field, and the
 *   two are mutually exclusive: typing an "Other" answer drops the selected option, and choosing
 *   an option drops the typed one. Sending both would ask the agent to honour two answers.
 * - Answered means "has a value the agent can read": an empty string is not one, an empty
 *   multi-select is not one, and `false` is.
 * - Required questions gate submission; everything else may be left out. A set with nothing
 *   required is therefore submittable with nothing answered - an accept that says nothing, which
 *   is a different answer from "Skip" (a cancellation), exactly as on the desktop.
 */

export function initialDecisionAnswers(): AgentDecisionResponseContent {
  return {}
}

/** Whether this question has an answer the agent can act on - its own, or its "Other" field's. */
export function isQuestionAnswered(content: AgentDecisionResponseContent, question: AgentDecisionQuestion): boolean {
  const custom = question.customAnswerId ? content[question.customAnswerId] : undefined
  if (typeof custom === 'string' && custom.trim() !== '') return true
  const value = content[question.id]
  if (value === undefined) return false
  if (typeof value === 'string') return value.trim() !== ''
  if (Array.isArray(value)) return value.length > 0
  return true
}

export function answeredCount(request: AgentDecisionRequest, content: AgentDecisionResponseContent): number {
  return request.questions.filter((question) => isQuestionAnswered(content, question)).length
}

/** Selects (or, for a multi-select, toggles) one option, dropping any conflicting "Other" text. */
export function chooseOption(
  content: AgentDecisionResponseContent,
  question: AgentDecisionQuestion,
  value: string
): AgentDecisionResponseContent {
  const next = { ...content }
  if (question.customAnswerId) delete next[question.customAnswerId]
  if (!question.multiSelect) return { ...next, [question.id]: value }
  const selected = Array.isArray(content[question.id]) ? (content[question.id] as string[]) : []
  return {
    ...next,
    [question.id]: selected.includes(value) ? selected.filter((entry) => entry !== value) : [...selected, value]
  }
}

export function isOptionSelected(
  content: AgentDecisionResponseContent,
  question: AgentDecisionQuestion,
  value: string
): boolean {
  const answer = content[question.id]
  return Array.isArray(answer) ? answer.includes(value) : answer === value
}

/**
 * Sets a typed value. An emptied field is *removed* rather than stored as an empty string: the
 * agent asked which fields were answered, and a blank one is not an answer to be transmitted.
 */
export function setTextAnswer(
  content: AgentDecisionResponseContent,
  question: AgentDecisionQuestion,
  text: string
): AgentDecisionResponseContent {
  const next = { ...content }
  if (text === '') delete next[question.id]
  else next[question.id] = text
  return next
}

export function setNumberAnswer(
  content: AgentDecisionResponseContent,
  question: AgentDecisionQuestion,
  raw: string
): AgentDecisionResponseContent {
  const next = { ...content }
  const value = Number(raw)
  if (raw.trim() === '' || !Number.isFinite(value)) delete next[question.id]
  else next[question.id] = value
  return next
}

export function setBooleanAnswer(
  content: AgentDecisionResponseContent,
  question: AgentDecisionQuestion,
  value: boolean
): AgentDecisionResponseContent {
  return { ...content, [question.id]: value }
}

/** Writes the "Other" field, which replaces this question's chosen option rather than joining it. */
export function setCustomAnswer(
  content: AgentDecisionResponseContent,
  question: AgentDecisionQuestion,
  text: string
): AgentDecisionResponseContent {
  if (!question.customAnswerId) return content
  const next = { ...content }
  if (text.trim() === '') {
    delete next[question.customAnswerId]
    return next
  }
  delete next[question.id]
  next[question.customAnswerId] = text
  return next
}

/**
 * What a typed field shows. A controlled input needs a string, and the answer it holds is not one
 * (a number, or nothing at all), so the conversion is stated here with the rest of the form's
 * rules rather than inline in JSX where it could not be tested.
 */
export function answerFieldText(content: AgentDecisionResponseContent, question: AgentDecisionQuestion): string {
  const value = content[question.id]
  if (typeof value === 'string') return value
  return typeof value === 'number' ? String(value) : ''
}

export function isBooleanAnswer(
  content: AgentDecisionResponseContent,
  question: AgentDecisionQuestion,
  value: boolean
): boolean {
  return content[question.id] === value
}

/**
 * Whether answering this question also answers "what next". A single-value choice does - it is one
 * tap, one decision, and the reader should land on the next question - while a multi-select must
 * not, because the reader is still adding to it.
 */
export function advancesOnAnswer(question: AgentDecisionQuestion): boolean {
  return !question.multiSelect
}

export function customAnswerText(content: AgentDecisionResponseContent, question: AgentDecisionQuestion): string {
  const value = question.customAnswerId ? content[question.customAnswerId] : undefined
  return typeof value === 'string' ? value : ''
}

/**
 * Why this answer cannot be submitted yet, or null. One place so the button and its hint cannot
 * disagree, and the wire-level bounds are the shared contract's own - the host would refuse an
 * over-large answer in exactly these words.
 */
export function submitDecisionProblem(
  request: AgentDecisionRequest,
  content: AgentDecisionResponseContent
): string | null {
  const remaining = request.questions.filter(
    (question) => question.required && !isQuestionAnswered(content, question)
  ).length
  if (remaining > 0) return `${remaining} required answer${remaining === 1 ? '' : 's'} remaining.`
  return decisionContentProblem(content)
}

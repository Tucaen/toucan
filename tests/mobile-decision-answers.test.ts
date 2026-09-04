import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  answeredCount,
  chooseOption,
  customAnswerText,
  initialDecisionAnswers,
  isOptionSelected,
  isQuestionAnswered,
  setBooleanAnswer,
  setCustomAnswer,
  setNumberAnswer,
  setTextAnswer,
  submitDecisionProblem
} from '../mobile/src/decision-answers'
import type { AgentDecisionQuestion, AgentDecisionRequest } from '../src/shared/agent'

/**
 * Filling in a structured question set on the phone. These are the desktop's rules restated as
 * data, so the two surfaces cannot answer the same elicitation differently - in particular the
 * mutual exclusion between a chosen option and an "Other" answer, which is the one place a form
 * could otherwise send the agent two answers to one question.
 */

function question(overrides: Partial<AgentDecisionQuestion> & { id: string }): AgentDecisionQuestion {
  return { question: 'Which?', options: [], input: 'select', multiSelect: false, ...overrides }
}

const SCOPE = question({
  id: 'scope',
  title: 'Scope',
  question: 'Read-only first?',
  options: [
    { value: 'Read-only', label: 'Read-only', description: 'Recommended' },
    { value: 'Complete CRUD', label: 'Complete CRUD' }
  ],
  required: true,
  customAnswerId: 'scope_custom'
})
const TAGS = question({
  id: 'tags',
  question: 'Which areas?',
  options: [
    { value: 'ui', label: 'UI' },
    { value: 'api', label: 'API' }
  ],
  multiSelect: true
})
const NOTE = question({ id: 'note', question: 'Anything else?', input: 'text' })
const RETRIES = question({ id: 'retries', question: 'How many retries?', input: 'number' })
const VERBOSE = question({ id: 'verbose', question: 'Verbose?', input: 'boolean' })

function request(questions: readonly AgentDecisionQuestion[]): AgentDecisionRequest {
  return { id: 'd1', message: 'Please answer the following questions.', questions: [...questions] }
}

test('a single-value option replaces, a multi-select toggles', () => {
  const chosen = chooseOption(initialDecisionAnswers(), SCOPE, 'Read-only')
  assert.deepEqual(chosen, { scope: 'Read-only' })
  assert.deepEqual(chooseOption(chosen, SCOPE, 'Complete CRUD'), { scope: 'Complete CRUD' })

  const one = chooseOption(initialDecisionAnswers(), TAGS, 'ui')
  const two = chooseOption(one, TAGS, 'api')
  assert.deepEqual(two, { tags: ['ui', 'api'] })
  assert.equal(isOptionSelected(two, TAGS, 'ui'), true)
  // Tapping a chosen option again removes it: on a phone that is the only way to undo a tap.
  assert.deepEqual(chooseOption(two, TAGS, 'ui'), { tags: ['api'] })
  assert.equal(isOptionSelected(chooseOption(two, TAGS, 'ui'), TAGS, 'ui'), false)
})

test('an "Other" answer and a chosen option are mutually exclusive in both directions', () => {
  const typed = setCustomAnswer(chooseOption(initialDecisionAnswers(), SCOPE, 'Read-only'), SCOPE, 'Only the reads')
  assert.deepEqual(typed, { scope_custom: 'Only the reads' })
  assert.equal(customAnswerText(typed, SCOPE), 'Only the reads')
  assert.equal(isQuestionAnswered(typed, SCOPE), true)

  // Choosing an option again drops the typed answer rather than sending both.
  assert.deepEqual(chooseOption(typed, SCOPE, 'Complete CRUD'), { scope: 'Complete CRUD' })
  // An emptied "Other" field is removed, so the question reads as unanswered again.
  assert.deepEqual(setCustomAnswer(typed, SCOPE, '   '), {})
})

test('answered means a value the agent can read, and false is one', () => {
  assert.equal(isQuestionAnswered({}, NOTE), false)
  assert.equal(isQuestionAnswered({ note: '   ' }, NOTE), false)
  assert.equal(isQuestionAnswered({ note: 'yes' }, NOTE), true)
  assert.equal(isQuestionAnswered({ tags: [] }, TAGS), false)
  assert.equal(isQuestionAnswered(setBooleanAnswer({}, VERBOSE, false), VERBOSE), true)
  assert.equal(answeredCount(request([SCOPE, NOTE]), { scope: 'Read-only' }), 1)
})

test('an emptied typed field is dropped rather than sent as a blank answer', () => {
  assert.deepEqual(setTextAnswer({ note: 'draft' }, NOTE, ''), {})
  assert.deepEqual(setNumberAnswer({}, RETRIES, '3'), { retries: 3 })
  assert.deepEqual(setNumberAnswer({ retries: 3 }, RETRIES, ''), {})
  // A field mid-edit ("-", "1e") is not a number yet; storing NaN would reach the agent as null.
  assert.deepEqual(setNumberAnswer({ retries: 3 }, RETRIES, '-'), {})
})

test('required questions gate submission, and an empty answer is a skip rather than a submit', () => {
  const set = request([SCOPE, NOTE])
  assert.match(submitDecisionProblem(set, {}) ?? '', /1 required answer remaining/)
  assert.equal(submitDecisionProblem(set, { scope: 'Read-only' }), null)
  // Two required, so the wording pluralizes rather than reading "1 required answers".
  assert.match(
    submitDecisionProblem(request([SCOPE, { ...NOTE, required: true }]), {}) ?? '',
    /2 required answers remaining/
  )
  // Nothing required and nothing answered is a valid accept - the desktop submits it too, and it
  // says something different from Skip, which cancels the request outright.
  assert.equal(submitDecisionProblem(request([NOTE]), {}), null)
})

test('an answer too large for the wire is refused in the words the host would use', () => {
  const oversized = { note: 'x'.repeat(5_000) }
  assert.match(submitDecisionProblem(request([NOTE]), oversized) ?? '', /at most/)
})

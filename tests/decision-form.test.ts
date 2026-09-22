import { strict as assert } from 'node:assert'
import { describe, it } from 'vitest'
import {
  allRequiredAnswered,
  decisionAnswered,
  decisionTabTarget,
  requiredAnswersRemaining,
  withChosenOption,
  withCustomAnswer,
  withNumberAnswer
} from '../src/renderer/src/decision-form'
import type { AgentDecisionQuestion } from '../src/shared/agent'

function question(overrides: Partial<AgentDecisionQuestion> = {}): AgentDecisionQuestion {
  return {
    id: 'q1',
    question: 'Which approach?',
    options: [
      { value: 'a', label: 'A' },
      { value: 'b', label: 'B' }
    ],
    input: 'select',
    multiSelect: false,
    ...overrides
  }
}

describe('decisionAnswered', () => {
  it('counts a chosen option, a boolean either way, and a number as answers', () => {
    assert.equal(decisionAnswered(question(), {}), false)
    assert.equal(decisionAnswered(question(), { q1: 'a' }), true)
    assert.equal(decisionAnswered(question({ input: 'boolean' }), { q1: false }), true)
    assert.equal(decisionAnswered(question({ input: 'number' }), { q1: 0 }), true)
  })

  it('requires substance: empty strings and empty selections are untouched controls', () => {
    assert.equal(decisionAnswered(question({ input: 'text' }), { q1: '' }), false)
    assert.equal(decisionAnswered(question({ multiSelect: true }), { q1: [] }), false)
    assert.equal(decisionAnswered(question({ multiSelect: true }), { q1: ['a'] }), true)
  })

  it('accepts a custom answer only when it carries non-whitespace text', () => {
    const q = question({ customAnswerId: 'q1-other' })
    assert.equal(decisionAnswered(q, { 'q1-other': '  ' }), false)
    assert.equal(decisionAnswered(q, { 'q1-other': 'something else' }), true)
  })
})

describe('required completion', () => {
  const questions = [
    question({ id: 'q1', required: true }),
    question({ id: 'q2' }),
    question({ id: 'q3', required: true })
  ]

  it('only required questions gate submission', () => {
    assert.equal(allRequiredAnswered(questions, {}), false)
    assert.equal(requiredAnswersRemaining(questions, {}), 2)
    assert.equal(allRequiredAnswered(questions, { q1: 'a', q3: 'b' }), true)
    assert.equal(requiredAnswersRemaining(questions, { q1: 'a' }), 1)
  })

  it('a form with no required questions is always submittable', () => {
    assert.equal(allRequiredAnswered([question()], {}), true)
    assert.equal(requiredAnswersRemaining([question()], {}), 0)
  })
})

describe('decisionTabTarget', () => {
  it('moves with the arrows, wrapping at the ends', () => {
    assert.equal(decisionTabTarget('ArrowRight', 0, 3), 1)
    assert.equal(decisionTabTarget('ArrowRight', 2, 3), 0)
    assert.equal(decisionTabTarget('ArrowLeft', 1, 3), 0)
    assert.equal(decisionTabTarget('ArrowLeft', 0, 3), 2)
  })

  it('jumps with Home and End', () => {
    assert.equal(decisionTabTarget('Home', 2, 3), 0)
    assert.equal(decisionTabTarget('End', 0, 3), 2)
  })

  it('leaves every other key alone', () => {
    assert.equal(decisionTabTarget('ArrowDown', 0, 3), null)
    assert.equal(decisionTabTarget('Enter', 1, 3), null)
  })
})

describe('withChosenOption', () => {
  it('replaces the answer on a single select and clears the custom answer', () => {
    const q = question({ customAnswerId: 'q1-other' })
    const next = withChosenOption(q, { q1: 'a', 'q1-other': 'typed' }, 'b')
    assert.deepEqual(next, { q1: 'b' })
  })

  it('toggles values on a multi select', () => {
    const q = question({ multiSelect: true })
    const added = withChosenOption(q, { q1: ['a'] }, 'b')
    assert.deepEqual(added, { q1: ['a', 'b'] })
    const removed = withChosenOption(q, added, 'a')
    assert.deepEqual(removed, { q1: ['b'] })
  })
})

describe('withCustomAnswer', () => {
  const q = question({ customAnswerId: 'q1-other' })

  it('text with substance displaces the chosen option', () => {
    assert.deepEqual(withCustomAnswer(q, { q1: 'a' }, 'my own answer'), { 'q1-other': 'my own answer' })
  })

  it('clearing the field removes the custom answer without restoring anything', () => {
    assert.deepEqual(withCustomAnswer(q, { 'q1-other': 'typed' }, ''), {})
  })

  it('is inert on a question with no custom answer field', () => {
    const answers = { q1: 'a' }
    assert.equal(withCustomAnswer(question(), answers, 'text'), answers)
  })
})

describe('withNumberAnswer', () => {
  const q = question({ input: 'number' })

  it('folds a typed number in and treats a cleared field as no answer', () => {
    assert.deepEqual(withNumberAnswer(q, {}, '42'), { q1: 42 })
    assert.deepEqual(withNumberAnswer(q, { q1: 42 }, ''), {})
  })
})

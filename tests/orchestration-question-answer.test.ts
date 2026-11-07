import { strict as assert } from 'node:assert'
import { test } from 'vitest'
import {
  pinnedQuestionDecision,
  pinnedQuestionNote,
  questionOptionsFromDecision
} from '../src/shared/orchestration-question-answer'

// A pinned question with options is the same one-question form a ticket session shows; what the
// human fills in comes back as the note that resolves it.

test('a plain-text question has no form', () => {
  assert.equal(pinnedQuestionDecision({ id: 'Q1' }), undefined)
  assert.equal(pinnedQuestionDecision({ id: 'Q1', options: [] }), undefined)
})

test('options become one required select with an Other field', () => {
  const request = pinnedQuestionDecision({
    id: 'Q2',
    ticketId: '3',
    options: [{ label: 'Left', description: 'the old one' }, { label: 'Right' }],
    multiSelect: true
  })
  assert.equal(request?.id, 'pinned:Q2')
  assert.match(request?.message ?? '', /Q2 · ticket #3/)
  assert.deepEqual(request?.questions, [
    {
      id: 'answer',
      question: 'Your answer',
      options: [
        { value: 'Left', label: 'Left', description: 'the old one' },
        { value: 'Right', label: 'Right' }
      ],
      input: 'select',
      multiSelect: true,
      required: true,
      customAnswerId: 'other',
      customAnswerHint: 'Or write your own answer'
    }
  ])
})

test('the note names the picked options, the Other text, or a skip', () => {
  assert.equal(pinnedQuestionNote({ answer: 'Left' }), 'Answer: Left')
  assert.equal(pinnedQuestionNote({ answer: ['Left', 'Right'] }), 'Answer: Left, Right')
  assert.equal(pinnedQuestionNote({ answer: 'Left', other: ' but later ' }), 'Answer: Left (note: but later)')
  assert.equal(pinnedQuestionNote({ other: 'Something else' }), 'Answer: Something else')
  assert.equal(pinnedQuestionNote({ answer: [], other: '  ' }), 'Skipped without an answer.')
  assert.equal(pinnedQuestionNote(), 'Skipped without an answer.')
  assert.ok(
    pinnedQuestionNote({ answer: Array.from({ length: 12 }, () => 'y'.repeat(200)), other: 'x'.repeat(10_000) })
      .length < 4000
  )
})

test('a single select question round-trips through the pinned form', () => {
  const options = [{ label: 'Left', description: 'the old one' }, { label: 'Right' }]
  for (const multiSelect of [false, true]) {
    const request = pinnedQuestionDecision({
      id: 'Q1',
      options,
      ...(multiSelect ? { multiSelect: true as const } : {})
    })!
    assert.deepEqual(questionOptionsFromDecision(request), { options, ...(multiSelect ? { multiSelect: true } : {}) })
  }
})

test('options are copied only from one select question with usable options', () => {
  const request = pinnedQuestionDecision({ id: 'Q1', options: [{ label: 'A' }, { label: 'B' }] })!
  const question = request.questions[0]!
  const error = (value: Parameters<typeof questionOptionsFromDecision>[0]): string =>
    (questionOptionsFromDecision(value) as { error: string }).error
  assert.match(error({ ...request, questions: [question, question] }), /2 questions/)
  assert.match(
    error({ ...request, questions: [{ ...question, input: 'boolean', options: [] }] }),
    /not a select question/
  )
  const twice = [
    { value: 'a', label: 'X' },
    { value: 'b', label: 'X' }
  ]
  assert.match(error({ ...request, questions: [{ ...question, options: twice }] }), /cannot be pinned.*twice/)
  assert.match(error({ ...request, questions: [] }), /0 questions/)
})

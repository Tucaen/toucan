import { strict as assert } from 'node:assert'
import { test } from 'vitest'
import {
  addOrchestrationQuestion,
  applyPlan,
  applyTicketUpdate,
  isOrchestrationRecord,
  openOrchestrationQuestions,
  ORCHESTRATION_QUESTION_LIMIT,
  parseQuestionAddInput,
  parseQuestionListInput,
  parseQuestionResolveInput,
  resolveOrchestrationQuestion,
  type OrchestrationRecord
} from '../src/shared/orchestration'
import { orchestrationControlState } from '../src/shared/ticket-session-spawn'

// Pinned open questions (#2 of the pinned-questions plan): a question for the human is stored once,
// verbatim, and referenced by its id afterwards, so its links and context never have to be repeated.

const identity = { provider: 'claude' as const, conversationId: 'conversation-1', projectPath: 'D:\\project' }
const plan = {
  task: 'Ship it',
  targetBranch: 'main',
  tickets: [
    { id: '3', title: 'Desktop strip', blockedBy: [] },
    { id: '4', title: 'Phone strip', blockedBy: [] }
  ]
}

function planned(): OrchestrationRecord {
  return applyPlan(undefined, plan, identity, '2026-11-03T10:00:00.000Z').record!
}

const markdown = 'Which layout?\n\n![before](file:///D:/Development/toucan/.toucan-scratch/before.png)\n'

test('a question is stored verbatim under the next id, Q1 first', () => {
  const first = addOrchestrationQuestion(planned(), { ticketId: '3', markdown }, '2026-11-03T10:01:00.000Z')
  assert.equal(first.error, undefined)
  assert.deepEqual(first.question, {
    id: 'Q1',
    ticketId: '3',
    markdown,
    createdAt: '2026-11-03T10:01:00.000Z'
  })
  const second = addOrchestrationQuestion(first.record!, { markdown: '  Ship today?  ' }, '2026-11-03T10:02:00.000Z')
  assert.equal(second.question?.id, 'Q2')
  assert.equal(second.question?.markdown, '  Ship today?  ')
  assert.equal(second.question?.ticketId, undefined)
  assert.equal(second.record?.updatedAt, '2026-11-03T10:02:00.000Z')
  assert.ok(isOrchestrationRecord(JSON.parse(JSON.stringify(second.record))))
})

test('ids are never reused, not even after the newest question is resolved', () => {
  let record = addOrchestrationQuestion(planned(), { markdown: 'a' }, 't1').record!
  record = addOrchestrationQuestion(record, { markdown: 'b' }, 't2').record!
  record = resolveOrchestrationQuestion(record, 'Q2', 't3').record!
  const third = addOrchestrationQuestion(record, { markdown: 'c' }, 't4')
  assert.equal(third.question?.id, 'Q3')
})

test('a question for an unknown or settled ticket is refused', () => {
  assert.match(addOrchestrationQuestion(planned(), { ticketId: '9', markdown }, 't').error ?? '', /no ticket "9"/)
  const merged = applyTicketUpdate(planned(), '3', { mergeStatus: 'merged' }, 't').record!
  assert.match(addOrchestrationQuestion(merged, { ticketId: '3', markdown }, 't').error ?? '', /already merged/)
})

test('resolving records when and why; a second resolve changes nothing', () => {
  const asked = addOrchestrationQuestion(planned(), { ticketId: '3', markdown }, 't1').record!
  const resolved = resolveOrchestrationQuestion(asked, 'Q1', 't2', 'go with the left one')
  assert.equal(resolved.changed, true)
  assert.deepEqual(resolved.question, {
    id: 'Q1',
    ticketId: '3',
    markdown,
    createdAt: 't1',
    resolvedAt: 't2',
    resolution: 'go with the left one'
  })
  assert.deepEqual(openOrchestrationQuestions(resolved.record!), [])
  const again = resolveOrchestrationQuestion(resolved.record!, 'Q1', 't3', 'other')
  assert.equal(again.changed, false)
  assert.equal(again.record, resolved.record)
  assert.equal(again.question?.resolution, 'go with the left one')
  assert.match(resolveOrchestrationQuestion(asked, 'Q7', 't').error ?? '', /no question Q7/)
})

test('a ticket that merges or is answered resolves its open questions, and only its own', () => {
  let record = addOrchestrationQuestion(planned(), { ticketId: '3', markdown: 'a' }, 't1').record!
  record = addOrchestrationQuestion(record, { ticketId: '4', markdown: 'b' }, 't1').record!
  record = addOrchestrationQuestion(record, { markdown: 'c' }, 't1').record!
  const merged = applyTicketUpdate(record, '3', { mergeStatus: 'merged' }, 't2').record!
  assert.deepEqual(
    openOrchestrationQuestions(merged).map((question) => question.id),
    ['Q2', 'Q3']
  )
  const q1 = merged.openQuestions?.find((question) => question.id === 'Q1')
  assert.equal(q1?.resolvedAt, 't2')
  assert.equal(q1?.resolution, 'ticket 3 merged')
  const answered = applyTicketUpdate(merged, '4', { mergeStatus: 'answered' }, 't3').record!
  assert.equal(answered.openQuestions?.find((question) => question.id === 'Q2')?.resolution, 'ticket 4 answered')
  // Any other update leaves the questions alone.
  const retitled = applyTicketUpdate(record, '3', { title: 'Renamed', mergeStatus: 'unmerged' }, 't4').record!
  assert.equal(openOrchestrationQuestions(retitled).length, 3)
})

test('a re-plan keeps every question, resolved ones included, even for a ticket it drops', () => {
  let record = addOrchestrationQuestion(planned(), { ticketId: '4', markdown: 'a' }, 't1').record!
  record = addOrchestrationQuestion(record, { markdown: 'b' }, 't1').record!
  record = resolveOrchestrationQuestion(record, 'Q2', 't2').record!
  const replanned = applyPlan(record, { ...plan, tickets: [plan.tickets[0]!] }, identity, 't3').record!
  assert.deepEqual(replanned.openQuestions, record.openQuestions)
  assert.equal(addOrchestrationQuestion(replanned, { markdown: 'c' }, 't4').question?.id, 'Q3')
})

test('the record predicate refuses a malformed question list', () => {
  const record = addOrchestrationQuestion(planned(), { markdown }, 't1').record!
  assert.ok(isOrchestrationRecord(record))
  assert.ok(isOrchestrationRecord(planned()))
  const broken = (question: unknown) => ({ ...record, openQuestions: [question] })
  assert.equal(isOrchestrationRecord(broken({ id: 'X1', markdown, createdAt: 't' })), false)
  assert.equal(isOrchestrationRecord(broken({ id: 'Q1', markdown: '', createdAt: 't' })), false)
  assert.equal(isOrchestrationRecord(broken({ id: 'Q1', markdown, createdAt: 't', resolvedAt: 5 })), false)
  assert.equal(isOrchestrationRecord({ ...record, openQuestions: 'Q1' }), false)
  assert.equal(
    isOrchestrationRecord({
      ...record,
      openQuestions: [
        { id: 'Q1', markdown, createdAt: 't' },
        { id: 'Q1', markdown, createdAt: 't' }
      ]
    }),
    false
  )
})

test('question inputs are validated; the markdown travels unchanged', () => {
  assert.deepEqual(parseQuestionAddInput({ ticket: ' 3 ', markdown }), { add: { ticketId: '3', markdown } })
  assert.deepEqual(parseQuestionAddInput({ markdown }), { add: { markdown } })
  assert.match(parseQuestionAddInput({ markdown: '  \n' }).error ?? '', /--text <markdown> or --file/)
  assert.match(parseQuestionAddInput({ ticket: '', markdown }).error ?? '', /--ticket needs/)
  assert.match(
    parseQuestionAddInput({ markdown: 'x'.repeat(ORCHESTRATION_QUESTION_LIMIT + 1) }).error ?? '',
    /longer than/
  )
  assert.match(parseQuestionAddInput({ markdown, extra: 1 }).error ?? '', /takes only/)

  assert.deepEqual(parseQuestionResolveInput({ id: 'q3' }), { resolve: { id: 'Q3' } })
  assert.deepEqual(parseQuestionResolveInput({ id: '3', note: 'done' }), { resolve: { id: 'Q3', note: 'done' } })
  assert.match(parseQuestionResolveInput({ id: 'Q' }).error ?? '', /--id <Q<n>>/)
  assert.match(parseQuestionResolveInput({ id: 'Q1', note: '  ' }).error ?? '', /--note needs/)

  assert.deepEqual(parseQuestionListInput(undefined), { list: { all: false } })
  assert.deepEqual(parseQuestionListInput({ all: true }), { list: { all: true } })
  assert.match(parseQuestionListInput({ all: 'yes' }).error ?? '', /takes only/)
})

test('the control state the UI renders carries the open questions verbatim, resolved ones dropped', () => {
  let record = addOrchestrationQuestion(planned(), { ticketId: '3', markdown }, 't1').record!
  record = addOrchestrationQuestion(record, { markdown: 'b' }, 't2').record!
  record = resolveOrchestrationQuestion(record, 'Q2', 't3', 'no').record!
  assert.deepEqual(orchestrationControlState(record).openQuestions, [
    { id: 'Q1', ticketId: '3', markdown, createdAt: 't1' }
  ])
  assert.deepEqual(orchestrationControlState(planned()).openQuestions, [])
})

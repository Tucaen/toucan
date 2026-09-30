import { strict as assert } from 'node:assert'
import { test } from 'vitest'
import { createOrchestrationWaker, type TicketBinding } from '../src/main/orchestration-wake'
import type { AgentEvent, AgentPromptResult } from '../src/shared/agent'

// Waking the orchestrator (#35): ticket session events become follow-up prompts to the orchestrator,
// folded when they arrive close together, and kept until a prompt actually got through.

const bindings: Record<string, TicketBinding> = {
  'ticket-a': { orchestratorNodeId: 'orchestrator', ticketId: '12', conversationId: 'conversation-a' },
  'ticket-b': { orchestratorNodeId: 'orchestrator', ticketId: '13', conversationId: 'conversation-b' }
}

function harness(options: { answers?: AgentPromptResult[]; resolve?: (nodeId: string) => TicketBinding | null } = {}) {
  const delivered: Array<{ nodeId: string; text: string }> = []
  const answers = [...(options.answers ?? [])]
  const timers: Array<() => void> = []
  const waker = createOrchestrationWaker({
    deliver: async (nodeId, text) => {
      delivered.push({ nodeId, text })
      return answers.shift() ?? { ok: true }
    },
    resolve: async (nodeId) => (options.resolve ? options.resolve(nodeId) : (bindings[nodeId] ?? null)),
    outcome: async (conversationId) =>
      conversationId === 'conversation-a' ? { path: 'C:\\outcomes\\toucan--a--1234.md', files: 4 } : undefined,
    schedule: (callback) => {
      timers.push(callback)
      return () => timers.splice(timers.indexOf(callback), 1)
    }
  })
  const fold = async (): Promise<void> => {
    await waker.idle()
    for (const timer of timers.splice(0)) timer()
    await waker.idle()
  }
  return { waker, delivered, fold, timers }
}

const complete: AgentEvent = { type: 'turn_complete', stopReason: 'end_turn' }

test('a finished ticket turn wakes its orchestrator with the event and where to read more', async () => {
  const { waker, delivered, fold } = harness()
  waker.observe('ticket-a', complete)
  await fold()
  assert.equal(delivered.length, 1)
  assert.equal(delivered[0].nodeId, 'orchestrator')
  assert.match(delivered[0].text, /#12 completed - 4 files - outcome record C:\\outcomes\\toucan--a--1234\.md/)
  assert.match(delivered[0].text, /outcome --ticket/)
})

test('events arriving close together are folded into one prompt', async () => {
  const { waker, delivered, fold } = harness()
  waker.observe('ticket-a', complete)
  waker.observe('ticket-b', { type: 'turn_failed', turnId: 't', message: 'Internal error' })
  waker.observe('ticket-b', {
    type: 'approval',
    approvalId: 'p1',
    title: 'Run npm install',
    options: [{ id: 'allow', label: 'Allow', kind: 'allow_once' }]
  })
  waker.observe('ticket-a', {
    type: 'decision_request',
    request: { id: 'q1', message: 'Which?', questions: [] }
  })
  await fold()
  assert.equal(delivered.length, 1)
  const text = delivered[0].text
  assert.match(text, /#12 completed/)
  assert.match(text, /#13 failed: Internal error/)
  assert.match(text, /#13 waits on a tool-permission prompt/)
  assert.match(text, /#12 asks a question/)
})

test('the prompt never carries the ticket session transcript', async () => {
  const { waker, delivered, fold } = harness()
  waker.observe('ticket-a', { type: 'message', role: 'assistant', messageId: 'm', text: 'SECRET TRANSCRIPT' })
  waker.observe('ticket-a', complete)
  await fold()
  assert.equal(delivered.length, 1)
  assert.doesNotMatch(delivered[0].text, /SECRET TRANSCRIPT/)
})

test('sessions that are not ticket sessions, and events that are not boundaries, wake nobody', async () => {
  const { waker, delivered, fold, timers } = harness()
  waker.observe('ordinary-chat', complete)
  waker.observe('ticket-a', { type: 'status', status: 'working' })
  await fold()
  assert.equal(delivered.length, 0)
  assert.equal(timers.length, 0)
})

test('a wake the orchestrator could not take yet is kept and delivered at its next ready boundary', async () => {
  const { waker, delivered, fold } = harness({
    answers: [{ ok: false, message: 'The agent session is not ready.', undelivered: true }]
  })
  waker.observe('ticket-a', complete)
  await fold()
  assert.equal(delivered.length, 1)
  // A second event arriving while the first is still owed joins it rather than overtaking it.
  waker.observe('ticket-b', { type: 'turn_cancelled', turnId: 't', message: 'Stopped by you.' })
  await fold()
  assert.equal(delivered.length, 1)
  waker.observe('orchestrator', { type: 'status', status: 'ready' })
  await fold()
  assert.equal(delivered.length, 2)
  assert.match(delivered[1].text, /#12 completed/)
  assert.match(delivered[1].text, /#13 cancelled/)
  waker.observe('orchestrator', { type: 'status', status: 'ready' })
  await fold()
  assert.equal(delivered.length, 2, 'a delivered wake is not sent again')
})

test('a wake the orchestrator accepted is not re-sent when its turn then fails', async () => {
  const { waker, delivered, fold } = harness({ answers: [{ ok: false, message: 'usage limit reached' }] })
  waker.observe('ticket-a', complete)
  await fold()
  waker.observe('orchestrator', { type: 'status', status: 'ready' })
  await fold()
  assert.equal(delivered.length, 1)
})

test('events a ticket session raised before its spawn returned are delivered once it is bound', async () => {
  const { waker, delivered, fold } = harness({ resolve: () => undefined as unknown as null })
  waker.observe('fresh-ticket', {
    type: 'approval',
    approvalId: 'p1',
    title: 'Edit file',
    options: []
  })
  await fold()
  assert.equal(delivered.length, 0)
  waker.bind('fresh-ticket', { orchestratorNodeId: 'orchestrator', ticketId: '14' })
  await fold()
  assert.equal(delivered.length, 1)
  assert.match(delivered[0].text, /#14 waits on a tool-permission prompt/)
})

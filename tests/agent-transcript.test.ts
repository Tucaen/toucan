import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import type { AgentCreateResult, AgentEvent } from '../src/shared/agent'
import {
  appendLocalUserMessage,
  applyAgentCreateResult,
  foldAgentEvent,
  initialAgentTranscriptState,
  type AgentTranscriptState
} from '../src/shared/agent-transcript'

const NOW = 1_700_000_000_000

function fold(events: readonly AgentEvent[], from = initialAgentTranscriptState()): AgentTranscriptState {
  return events.reduce((state, event, index) => foldAgentEvent(state, event, NOW + index), from)
}

function message(
  role: 'user' | 'assistant' | 'thought',
  messageId: string,
  text: string,
  presentation?: 'progress' | 'final'
): AgentEvent {
  return { type: 'message', role, messageId, text, ...(presentation ? { presentation } : {}) }
}

test('folds a live turn: chunk accumulation, activity order, and final-message promotion', () => {
  const state = fold([
    { type: 'status', status: 'working' },
    message('user', 'u1', 'Fix the bug'),
    message('thought', 't1', 'Looking at the code'),
    message('assistant', 'a1', 'I will look '),
    message('assistant', 'a1', 'at the tests first.'),
    { type: 'activity', activity: { id: 'call1', title: 'Read tests', status: 'in_progress' } },
    { type: 'activity', activity: { id: 'call1', status: 'completed' } },
    message('assistant', 'a2', 'Fixed it.'),
    { type: 'turn_complete', stopReason: 'end_turn' },
    { type: 'status', status: 'idle' }
  ])

  assert.equal(state.status, 'ready')
  assert.deepEqual(
    state.messages.map((entry) => ({ id: entry.id, role: entry.role, text: entry.text })),
    [
      { id: 'u1', role: 'user', text: 'Fix the bug' },
      { id: 't1', role: 'thought', text: 'Looking at the code' },
      { id: 'a1', role: 'assistant', text: 'I will look at the tests first.' },
      { id: 'a2', role: 'assistant', text: 'Fixed it.' }
    ]
  )
  // Unphased assistant text settles at the turn boundary: last message final, the rest progress.
  const [, , a1, a2] = state.messages
  assert.deepEqual(
    [a1, a2].map((entry) => ({ presentation: entry.presentation, complete: entry.complete })),
    [
      { presentation: 'progress', complete: true },
      { presentation: 'final', complete: true }
    ]
  )
  assert.deepEqual(state.transcript, [
    { type: 'message', id: 'u1', role: 'user' },
    { type: 'message', id: 't1', role: 'thought' },
    { type: 'message', id: 'a1', role: 'assistant' },
    { type: 'activity', id: 'call1' },
    { type: 'message', id: 'a2', role: 'assistant' }
  ])
  // mergeActivity folded the patch and stamped first-seen timing.
  const activity = state.activities['call1']
  assert.equal(activity.title, 'Read tests')
  assert.equal(activity.status, 'completed')
  assert.equal(activity.startedAt, NOW + 5)
  assert.equal(activity.endedAt, NOW + 6)
})

test('a resumed-session replay reconstructs turn boundaries from user messages', () => {
  const replay: AgentEvent[] = [
    { type: 'session', sessionId: 'sess-1' },
    message('user', 'u1', 'First question'),
    message('assistant', 'a1', 'Interim narration.'),
    message('assistant', 'a2', 'First answer.'),
    message('user', 'u2', 'Second question'),
    message('assistant', 'a3', 'Second answer.')
  ]
  const result: AgentCreateResult = { ok: true, status: 'ready', sessionId: 'sess-1' }
  const state = applyAgentCreateResult(fold(replay), result)

  assert.equal(state.sessionId, 'sess-1')
  assert.equal(state.status, 'ready')
  // No turn_complete arrives during session/load replay; each user message closes the turn
  // before it, so only the last assistant message of each replayed turn reads as final.
  assert.deepEqual(
    state.messages
      .filter((entry) => entry.role === 'assistant')
      .map((entry) => ({ id: entry.id, presentation: entry.presentation, complete: entry.complete })),
    [
      { id: 'a1', presentation: 'progress', complete: true },
      { id: 'a2', presentation: 'final', complete: true },
      { id: 'a3', presentation: 'final', complete: true }
    ]
  )
})

test('a live turn after a settled replay settles independently of the replayed messages', () => {
  const resumed = applyAgentCreateResult(
    fold([message('user', 'u1', 'Earlier question'), message('assistant', 'a1', 'Earlier answer.')]),
    { ok: true, status: 'ready' }
  )
  const state = fold(
    [
      { type: 'status', status: 'working' },
      message('user', 'u2', 'Follow-up'),
      message('assistant', 'a2', 'Working on it.'),
      message('assistant', 'a3', 'Done.'),
      { type: 'turn_complete', stopReason: 'end_turn' }
    ],
    resumed
  )

  assert.deepEqual(
    state.messages
      .filter((entry) => entry.role === 'assistant')
      .map((entry) => ({ id: entry.id, presentation: entry.presentation })),
    [
      { id: 'a1', presentation: 'final' },
      { id: 'a2', presentation: 'progress' },
      { id: 'a3', presentation: 'final' }
    ]
  )
})

test('an in-flight turn keeps streaming state until its boundary arrives', () => {
  const state = fold([
    { type: 'status', status: 'working' },
    message('user', 'u1', 'Long task'),
    message('assistant', 'a1', 'Still going')
  ])

  assert.equal(state.status, 'working')
  const assistant = state.messages[1]
  assert.equal(assistant.complete, false)
  assert.equal(assistant.presentation, 'progress')
  assert.equal(assistant.presentationProvisional, true)
})

test('provider-phased text keeps its phase instead of the turn-boundary inference', () => {
  const state = fold([
    message('assistant', 'a1', 'Commentary.', 'progress'),
    message('assistant', 'a2', 'The result.', 'final'),
    message('assistant', 'a3', 'Trailing commentary.', 'progress'),
    { type: 'turn_complete', stopReason: 'end_turn' }
  ])

  assert.deepEqual(
    state.messages.map((entry) => entry.presentation),
    ['progress', 'final', 'progress']
  )
  assert.ok(state.messages.every((entry) => entry.complete === true && entry.presentationProvisional === false))
})

test('turn outcomes dedupe by turn id, stay bounded, and drive failure identity', () => {
  const failures: AgentEvent[] = Array.from({ length: 25 }, (_, index) => ({
    type: 'turn_failed',
    turnId: `turn-${index}`,
    message: `boom ${index}`
  }))
  const state = fold([
    ...failures,
    { type: 'turn_failed', turnId: 'turn-24', message: 'boom 24' },
    { type: 'turn_cancelled', turnId: 'turn-x', message: 'stopped' }
  ])

  assert.equal(state.outcomes.length, 20)
  assert.equal(state.outcomes[0].id, 'turn-6')
  assert.equal(state.outcomes.at(-1)?.id, 'turn-x')
  assert.equal(state.outcomes.at(-1)?.status, 'cancelled')
  // The cancelled turn is not a failure; the last genuine failure stays identifiable.
  assert.equal(state.failure, 'boom 24')
  assert.equal(state.failureKey, 'turn-24')
  // The duplicate turn_failed did not enter the order twice.
  assert.equal(state.transcript.filter((entry) => entry.type === 'outcome' && entry.id === 'turn-24').length, 1)
})

test('decision requests update in place, resolve out, and keep FIFO order', () => {
  const request = (id: string, question: string): AgentEvent => ({
    type: 'decision_request',
    request: { id, message: question, questions: [] }
  })
  let state = fold([request('d1', 'First?'), request('d2', 'Second?'), request('d1', 'First, reworded?')])
  assert.deepEqual(
    state.decisionRequests.map((entry) => ({ id: entry.id, message: entry.message })),
    [
      { id: 'd1', message: 'First, reworded?' },
      { id: 'd2', message: 'Second?' }
    ]
  )
  state = foldAgentEvent(state, { type: 'decision_resolved', requestId: 'd1' }, NOW)
  assert.deepEqual(
    state.decisionRequests.map((entry) => entry.id),
    ['d2']
  )
})

test('session metadata folds: modes fallback, usage patches, auth link lifecycle', () => {
  const state = fold([
    { type: 'modes', modes: { currentModeId: 'ask', availableModes: [{ id: 'ask', name: 'Ask' }] } },
    { type: 'modes', modes: { currentModeId: 'code', availableModes: [] } },
    { type: 'usage', used: 1000, size: 200000 },
    { type: 'usage', used: 2000, cost: { amount: 0.5, currency: 'USD' } },
    { type: 'auth_link', url: 'https://example.test/old' },
    { type: 'auth', methods: [{ id: 'm', name: 'Login', type: 'terminal' }] },
    { type: 'error', message: 'transport hiccup' }
  ])

  // A modes update without a list keeps the list already shown.
  assert.equal(state.modes?.currentModeId, 'code')
  assert.deepEqual(
    state.modes?.availableModes.map((mode) => mode.id),
    ['ask']
  )
  // usage_update is a patch: the second update must not blank the known window.
  assert.deepEqual(state.usage, { used: 2000, size: 200000, cost: { amount: 0.5, currency: 'USD' } })
  // A fresh auth cycle invalidates the previous cycle's sign-in link.
  assert.equal(state.authLink, null)
  assert.equal(state.authMethods.length, 1)
  assert.equal(state.failure, 'transport hiccup')
  assert.equal(state.failureKey, null)
})

test('a locally sent user message takes a transcript slot ahead of the reply that follows', () => {
  let state = appendLocalUserMessage(initialAgentTranscriptState(), {
    id: 'local-1',
    role: 'user',
    text: 'hello',
    queued: true
  })
  state = foldAgentEvent(state, message('assistant', 'a1', 'hi'), NOW)
  assert.deepEqual(state.transcript, [
    { type: 'message', id: 'local-1', role: 'user' },
    { type: 'message', id: 'a1', role: 'assistant' }
  ])
  assert.equal(state.messages[0].queued, true)
})

test('a failed create result lands exited with its message', () => {
  const state = applyAgentCreateResult(initialAgentTranscriptState(), {
    ok: false,
    status: 'error',
    message: 'adapter missing'
  })
  assert.equal(state.status, 'exited')
  assert.equal(state.detail, 'adapter missing')
})

test('an approval answered anywhere clears the pending approval every subscriber sees', () => {
  const raised = fold([
    {
      type: 'approval',
      approvalId: 'ap-1',
      title: 'Run npm test',
      options: [{ id: 'allow', label: 'Allow', kind: 'allow_once' }]
    }
  ])
  assert.equal(raised.approval?.id, 'ap-1')

  const resolved = fold([{ type: 'approval_resolved', approvalId: 'ap-1' }], raised)
  assert.equal(resolved.approval, null)
})

test('a stale approval_resolved does not clear a newer pending approval', () => {
  const state = fold([
    {
      type: 'approval',
      approvalId: 'ap-2',
      title: 'Edit file',
      options: [{ id: 'allow', label: 'Allow', kind: 'allow_once' }]
    },
    { type: 'approval_resolved', approvalId: 'ap-1' }
  ])
  assert.equal(state.approval?.id, 'ap-2')
})

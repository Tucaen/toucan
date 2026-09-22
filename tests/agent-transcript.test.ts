import { strict as assert } from 'node:assert'
import { test } from 'vitest'
import type { AgentCreateResult, AgentEvent } from '../src/shared/agent'
import {
  appendLocalUserMessage,
  applyAgentCreateResult,
  foldAgentEvent,
  initialAgentTranscriptState,
  type AgentTranscriptState,
  type LocalAgentEvent
} from '../src/shared/agent-transcript'

const NOW = 1_700_000_000_000

function fold(
  events: readonly (AgentEvent | LocalAgentEvent)[],
  from = initialAgentTranscriptState()
): AgentTranscriptState {
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
    { type: 'status', status: 'ready' }
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
  // No delegation policy on the request means none reported - and none invented.
  assert.equal(state.routineDelegation, null)
  assert.equal(state.decisionDelegation, null)
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

test('the create result carries the launch-time delegation policy into the transcript state', () => {
  // Issue #178: what a session actually launched with is main's report, folded like every other
  // create-result field - the renderer's preference is only ever the request.
  const result: AgentCreateResult = {
    ok: true,
    status: 'ready',
    sessionId: 'sess-1',
    routineDelegation: { workerModelId: 'gpt-5.6-luna', workerEffortId: 'low', status: 'configured' },
    // Issue #213: the decision policy folds through the very same seam, independently.
    decisionDelegation: { status: 'unavailable', message: 'Decision delegation applies to Claude sessions for now.' }
  }
  const state = applyAgentCreateResult(initialAgentTranscriptState(), result)
  assert.deepEqual(state.routineDelegation, {
    workerModelId: 'gpt-5.6-luna',
    workerEffortId: 'low',
    status: 'configured'
  })
  assert.equal(state.decisionDelegation?.status, 'unavailable')
  assert.match(state.decisionDelegation?.message ?? '', /Claude sessions for now/)
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

// The local events below are this client's own optimism folded through the same reducer, so the
// precedence rule has one home: main wins for anything that crossed the seam.

test('an optimistic prompt start is undone by its own failure when no main status event landed', () => {
  const started = fold([{ type: 'status', status: 'ready' }, { type: 'local_prompt_started' }])
  assert.equal(started.status, 'working')

  const failed = fold([{ type: 'local_prompt_failed', message: 'Could not read the workspace context.' }], started)
  assert.equal(failed.status, 'ready')
  assert.equal(failed.detail, 'Could not read the workspace context.')
})

test('main status events outrank the optimistic working when the prompt failure settles (issue #156)', () => {
  const methods = [{ id: 'claude-ai-login', name: 'Claude Subscription', type: 'terminal' as const }]
  const authRequired = fold([
    { type: 'status', status: 'ready' },
    { type: 'local_prompt_started' },
    { type: 'auth', methods },
    { type: 'status', status: 'auth_required', message: 'OAuth session expired' },
    { type: 'local_prompt_failed', message: 'OAuth session expired' }
  ])
  assert.equal(authRequired.status, 'auth_required')
  assert.equal(authRequired.detail, 'OAuth session expired')
  assert.equal(authRequired.authMethods.length, 1)

  // Main can even re-report 'working' (the turn genuinely started); a late local failure verdict
  // must not undo a status main owns.
  const mainWorking = fold([
    { type: 'status', status: 'ready' },
    { type: 'local_prompt_started' },
    { type: 'status', status: 'working' },
    { type: 'local_prompt_failed', message: 'turn failed late' }
  ])
  assert.equal(mainWorking.status, 'working')
  assert.equal(mainWorking.detail, 'turn failed late')
})

test('an optimistic working then a main ready lands ready and stays there through the failure fold', () => {
  const state = fold([
    { type: 'status', status: 'ready' },
    { type: 'local_prompt_started' },
    { type: 'turn_failed', turnId: 'turn-1', message: 'The provider rejected the turn.' },
    { type: 'status', status: 'ready' },
    { type: 'local_prompt_failed', message: 'The provider rejected the turn.' }
  ])
  assert.equal(state.status, 'ready')
  assert.equal(state.detail, 'The provider rejected the turn.')
})

test('a local selection anticipates main; the next main selection event wins', () => {
  const models = {
    currentModelId: 'a',
    availableModels: [
      { id: 'a', name: 'A' },
      { id: 'b', name: 'B' }
    ]
  }
  let state = fold([
    { type: 'models', models },
    { type: 'local_model_selected', modelId: 'b' }
  ])
  assert.equal(state.models?.currentModelId, 'b')

  state = fold([{ type: 'models', models }], state)
  assert.equal(state.models?.currentModelId, 'a')

  // A selection folded before any list is known has nothing to patch and must not invent one.
  assert.equal(fold([{ type: 'local_model_selected', modelId: 'b' }]).models, null)
})

test('local mode and effort selections patch their current ids in place', () => {
  const state = fold([
    { type: 'modes', modes: { currentModeId: 'ask', availableModes: [{ id: 'ask', name: 'Ask' }] } },
    { type: 'efforts', efforts: { currentEffortId: 'low', availableEfforts: [{ id: 'low', name: 'Low' }] } },
    { type: 'local_mode_selected', modeId: 'code' },
    { type: 'local_effort_selected', effortId: 'high' }
  ])
  assert.equal(state.modes?.currentModeId, 'code')
  assert.equal(state.efforts?.currentEffortId, 'high')
})

test('a local approval answer clears the card once; the late broadcast resolution is a no-op', () => {
  const approval: AgentEvent = {
    type: 'approval',
    approvalId: 'ap-1',
    title: 'Run npm test',
    options: [{ id: 'allow', label: 'Allow', kind: 'allow_once' }]
  }
  const resolved = fold([approval, { type: 'local_approval_resolved', approvalId: 'ap-1' }])
  assert.equal(resolved.approval, null)
  assert.equal(fold([{ type: 'approval_resolved', approvalId: 'ap-1' }], resolved).approval, null)

  // A stale local resolve (an already-superseded approval) must not clear a newer request.
  const superseded = fold(
    [
      { ...approval, approvalId: 'ap-2', title: 'Edit file' },
      { type: 'local_approval_resolved', approvalId: 'ap-1' }
    ],
    resolved
  )
  assert.equal(superseded.approval?.id, 'ap-2')
})

test('a local decision answer retires the request ahead of the broadcast', () => {
  const request = (id: string): AgentEvent => ({
    type: 'decision_request',
    request: { id, message: '?', questions: [] }
  })
  let state = fold([request('d1'), request('d2'), { type: 'local_decision_resolved', requestId: 'd1' }])
  assert.deepEqual(
    state.decisionRequests.map((entry) => entry.id),
    ['d2']
  )
  state = fold([{ type: 'decision_resolved', requestId: 'd1' }], state)
  assert.deepEqual(
    state.decisionRequests.map((entry) => entry.id),
    ['d2']
  )
})

test('the local auth cycle keeps methods and link visible while starting, and a ready verdict clears them', () => {
  const methods = [{ id: 'claude-ai-login', name: 'Claude Subscription', type: 'terminal' as const }]
  const waiting = fold([
    { type: 'auth', methods },
    { type: 'status', status: 'auth_required' },
    { type: 'local_auth_started' },
    { type: 'auth_link', url: 'https://claude.ai/oauth/authorize?client_id=abc' }
  ])
  assert.equal(waiting.status, 'starting')
  assert.equal(waiting.authMethods.length, 1)
  assert.equal(waiting.authLink, 'https://claude.ai/oauth/authorize?client_id=abc')

  const ready = fold([{ type: 'local_auth_settled', status: 'ready' }], waiting)
  assert.equal(ready.status, 'ready')
  assert.deepEqual(ready.authMethods, [])
  assert.equal(ready.authLink, null)

  const stillRequired = fold(
    [{ type: 'local_auth_settled', status: 'auth_required', message: 'Still waiting' }],
    waiting
  )
  assert.equal(stillRequired.status, 'auth_required')
  assert.equal(stillRequired.detail, 'Still waiting')

  const failed = fold([{ type: 'local_auth_settled', status: 'error', message: 'adapter crashed' }], waiting)
  assert.equal(failed.status, 'exited')
  assert.equal(failed.detail, 'adapter crashed')
})

test('a main status reporting the session past auth clears stale methods and link', () => {
  const methods = [{ id: 'claude-ai-login', name: 'Claude Subscription', type: 'terminal' as const }]
  const waiting = fold([
    { type: 'auth', methods },
    { type: 'status', status: 'auth_required' },
    { type: 'auth_link', url: 'https://claude.ai/oauth/authorize?client_id=abc' }
  ])
  // Neither auth_required nor starting ends the cycle: mid-reauth the link must stay actionable.
  const stillWaiting = fold([{ type: 'status', status: 'starting' }], waiting)
  assert.equal(stillWaiting.authMethods.length, 1)
  assert.equal(stillWaiting.authLink, 'https://claude.ai/oauth/authorize?client_id=abc')

  const recovered = fold([{ type: 'status', status: 'ready' }], waiting)
  assert.deepEqual(recovered.authMethods, [])
  assert.equal(recovered.authLink, null)
})

test('local delivery bookkeeping: an acknowledged send sheds its flags, a dropped one reads failed', () => {
  const sent = fold([
    {
      type: 'local_user_message',
      message: { id: 'm1', role: 'user', text: 'hello', queued: true, deliveryPending: true }
    }
  ])
  assert.deepEqual(sent.transcript, [{ type: 'message', id: 'm1', role: 'user' }])

  const delivered = fold([{ type: 'local_message_delivered', messageId: 'm1' }], sent)
  assert.deepEqual(delivered.messages, [{ id: 'm1', role: 'user', text: 'hello', queued: false }])

  const dropped = fold([{ type: 'local_send_failed', messageId: 'm1' }], sent)
  assert.equal(dropped.messages[0].failed, true)
  assert.equal(dropped.messages[0].queued, false)
  assert.equal(dropped.messages[0].deliveryPending, false)
})

test('local_detail sets the transient detail without touching anything else', () => {
  const before = fold([{ type: 'status', status: 'working' }])
  const state = fold([{ type: 'local_detail', message: 'Could not read the pasted image.' }], before)
  assert.equal(state.detail, 'Could not read the pasted image.')
  assert.equal(state.status, 'working')
})

test('an image chunk lands on the message its prose belongs to, keyed by the slot it occupies', () => {
  const state = fold([
    { type: 'message', role: 'assistant', messageId: 'answer-1', text: 'Here is the comparison.' },
    {
      type: 'message',
      role: 'assistant',
      messageId: 'answer-1',
      text: '',
      images: [{ data: 'b25l', mimeType: 'image/png' }]
    },
    {
      type: 'message',
      role: 'assistant',
      messageId: 'answer-1',
      text: '',
      images: [{ data: 'dHdv', mimeType: 'image/png' }]
    }
  ])

  assert.equal(state.messages.length, 1)
  assert.equal(state.messages[0]?.text, 'Here is the comparison.')
  assert.deepEqual(state.messages[0]?.images, [
    { id: 'answer-1#0', data: 'b25l', mimeType: 'image/png' },
    { id: 'answer-1#1', data: 'dHdv', mimeType: 'image/png' }
  ])
})

test('an image-first message keeps its images when the prose chunk arrives after them', () => {
  const state = fold([
    {
      type: 'message',
      role: 'assistant',
      messageId: 'answer-2',
      text: '',
      images: [{ data: 'b25l', mimeType: 'image/png' }]
    },
    { type: 'message', role: 'assistant', messageId: 'answer-2', text: 'And here it is.' }
  ])

  assert.equal(state.messages[0]?.text, 'And here it is.')
  assert.deepEqual(state.messages[0]?.images, [{ id: 'answer-2#0', data: 'b25l', mimeType: 'image/png' }])
})

test('a tool call keeps the images it returned across the patches that follow it', () => {
  const state = fold([
    {
      type: 'activity',
      activity: {
        id: 'image-1',
        status: 'completed',
        images: [{ id: 'image-1#0', data: 'b25l', mimeType: 'image/png' }]
      }
    },
    { type: 'activity', activity: { id: 'image-1', status: 'completed' } }
  ])

  assert.deepEqual(state.activities['image-1']?.images, [{ id: 'image-1#0', data: 'b25l', mimeType: 'image/png' }])
})

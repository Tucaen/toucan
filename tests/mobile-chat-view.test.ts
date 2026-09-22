import { strict as assert } from 'node:assert'
import { test } from 'vitest'
import { activitySummaryLine, chatStatusSummary, deriveChatViewItems } from '../mobile/src/chat-view'
import type { AgentEvent } from '../src/shared/agent'
import {
  applyAgentCreateResult,
  foldAgentEvent,
  initialAgentTranscriptState,
  type AgentTranscriptState
} from '../src/shared/agent-transcript'

/**
 * What the phone shows of a transcript, driven through the shared reducer so the presentation
 * rules under test are the ones a real event stream produces - especially final versus provisional
 * assistant text, which must match the desktop's reading of the same session.
 */

const NOW = 1_700_000_000_000

function foldAll(events: readonly AgentEvent[], from = initialAgentTranscriptState()): AgentTranscriptState {
  return events.reduce((state, event) => foldAgentEvent(state, event, NOW), from)
}

test('dialogue renders as bubbles in transcript order with activity summaries between', () => {
  const state = foldAll([
    { type: 'message', role: 'user', messageId: 'u1', text: 'fix the bug' },
    {
      type: 'activity',
      activity: { id: 't1', title: 'Read `parser.ts`', status: 'completed', kind: 'read' }
    },
    { type: 'message', role: 'assistant', messageId: 'a1', text: 'Done, the parser is fixed.' },
    { type: 'turn_complete', stopReason: 'end_turn' }
  ])

  const items = deriveChatViewItems(state)
  assert.deepEqual(
    items.map((item) => item.type),
    ['bubble', 'activity', 'bubble']
  )
  assert.equal(items[0]?.type === 'bubble' && items[0].role, 'user')
  assert.equal(items[1]?.type === 'activity' && items[1].label, 'Read parser.ts')
  assert.equal(items[1]?.type === 'activity' && items[1].state, 'done')
  assert.equal(items[2]?.type === 'bubble' && items[2].final, true)
})

test('streaming commentary is provisional until the turn boundary promotes the last message', () => {
  const streaming = foldAll([
    { type: 'status', status: 'working' },
    { type: 'message', role: 'assistant', messageId: 'a1', text: 'Looking at the parser first…' }
  ])
  const midTurn = deriveChatViewItems(streaming)
  assert.equal(midTurn[0]?.type === 'bubble' && midTurn[0].final, false)
  assert.equal(midTurn[0]?.type === 'bubble' && midTurn[0].streaming, true)

  const settled = foldAll(
    [
      { type: 'message', role: 'assistant', messageId: 'a2', text: 'The parser is fixed.' },
      { type: 'turn_complete', stopReason: 'end_turn' }
    ],
    streaming
  )
  const done = deriveChatViewItems(settled)
  // The shared presentation rule: only the last message of the completed turn reads as final.
  assert.equal(done[0]?.type === 'bubble' && done[0].final, false)
  assert.equal(done[1]?.type === 'bubble' && done[1].final, true)
  assert.equal(done[1]?.type === 'bubble' && done[1].streaming, false)
})

test('provider-phased commentary keeps its progress reading even after the turn ends', () => {
  const state = foldAll([
    { type: 'message', role: 'assistant', messageId: 'a1', text: 'commentary', presentation: 'progress' },
    { type: 'message', role: 'assistant', messageId: 'a2', text: 'the answer', presentation: 'final' },
    { type: 'turn_complete', stopReason: 'end_turn' }
  ])
  const items = deriveChatViewItems(state)
  assert.equal(items[0]?.type === 'bubble' && items[0].final, false)
  assert.equal(items[1]?.type === 'bubble' && items[1].final, true)
})

test('adjacent reasoning collapses to one indicator, split by anything between deliberations', () => {
  const state = foldAll([
    { type: 'status', status: 'working' },
    { type: 'message', role: 'thought', messageId: 'th1', text: 'hmm' },
    { type: 'message', role: 'thought', messageId: 'th2', text: 'so the parser' },
    { type: 'activity', activity: { id: 't1', title: 'Read `parser.ts`' } },
    { type: 'message', role: 'thought', messageId: 'th3', text: 'right' }
  ])
  const items = deriveChatViewItems(state)
  assert.deepEqual(
    items.map((item) => item.type),
    ['reasoning', 'activity', 'reasoning']
  )
  // Only the trailing indicator of a working session pulses.
  assert.equal(items[0]?.type === 'reasoning' && items[0].streaming, false)
  assert.equal(items[2]?.type === 'reasoning' && items[2].streaming, true)
})

test('replayed reasoning does not pulse once the session settled idle', () => {
  const state = applyAgentCreateResult(
    foldAll([{ type: 'message', role: 'thought', messageId: 'th1', text: 'restored deliberation' }]),
    { ok: true, status: 'ready' }
  )
  const items = deriveChatViewItems(state)
  assert.equal(items[0]?.type === 'reasoning' && items[0].streaming, false)
})

test('failed and cancelled turns stay visible as boundaries in transcript order', () => {
  const state = foldAll([
    { type: 'message', role: 'user', messageId: 'u1', text: 'try it' },
    { type: 'turn_failed', turnId: 'turn-1', message: 'The provider rejected the request.' },
    { type: 'message', role: 'user', messageId: 'u2', text: 'again' },
    { type: 'turn_cancelled', turnId: 'turn-2', message: 'Stopped.' }
  ])
  const items = deriveChatViewItems(state)
  assert.deepEqual(
    items.map((item) => item.type),
    ['bubble', 'outcome', 'bubble', 'outcome']
  )
  assert.equal(items[1]?.type === 'outcome' && items[1].status, 'failed')
  assert.equal(items[3]?.type === 'outcome' && items[3].status, 'cancelled')
})

test('activity summaries fall back from title to tool name plus short subject', () => {
  assert.equal(activitySummaryLine({ id: '1', title: 'Read `parser.ts`' }), 'Read parser.ts')
  assert.equal(
    activitySummaryLine({ id: '2', toolName: 'Read', locations: ['d:\\repo\\src\\parser.ts'] }),
    'Read parser.ts'
  )
  assert.equal(activitySummaryLine({ id: '3', kind: 'execute' }), 'execute')
  assert.equal(activitySummaryLine({ id: '4' }), 'Tool call')
})

test('the status pill reads working, idle, sign-in and exited from the reducer status', () => {
  assert.deepEqual(chatStatusSummary(foldAll([{ type: 'status', status: 'working' }])), {
    label: 'Working',
    tone: 'working'
  })
  assert.deepEqual(chatStatusSummary(foldAll([{ type: 'status', status: 'ready' }])), { label: 'Idle', tone: 'idle' })
  assert.deepEqual(chatStatusSummary(foldAll([{ type: 'status', status: 'auth_required' }])), {
    label: 'Needs sign-in',
    tone: 'attention'
  })
  assert.deepEqual(chatStatusSummary(foldAll([{ type: 'status', status: 'exited' }])), {
    label: 'Exited',
    tone: 'attention'
  })
})

test('empty assistant chunks do not render as blank bubbles', () => {
  const state = foldAll([{ type: 'message', role: 'assistant', messageId: 'a1', text: '' }])
  assert.deepEqual(deriveChatViewItems(state), [])
})

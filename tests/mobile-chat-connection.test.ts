import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  applyServerFrame,
  chatGone,
  connectionLost,
  initialChatConnectionState,
  reconnectDelayMs,
  type ChatConnectionState
} from '../mobile/src/chat-connection'
import type { AgentEvent } from '../src/shared/agent'
import { foldAgentEvent, initialAgentTranscriptState, type AgentTranscriptState } from '../src/shared/agent-transcript'

/**
 * The mobile fold of snapshot + tail: the reducer-level reconnect correctness the ticket names as
 * the hard part. Everything here drives the pure module with the frames the host actually sends,
 * and convergence is asserted against folding the full stream in one place - the desktop's view.
 */

const NOW = 1_700_000_000_000

function frame(message: unknown): string {
  return JSON.stringify(message)
}

function assistantChunk(messageId: string, text: string): AgentEvent {
  return { type: 'message', role: 'assistant', messageId, text }
}

function foldAll(events: readonly AgentEvent[], from = initialAgentTranscriptState()): AgentTranscriptState {
  return events.reduce((state, event) => foldAgentEvent(state, event, NOW), from)
}

/** What a state looks like after riding the wire: JSON drops keys whose value is undefined. */
function overWire<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function applyFrames(state: ChatConnectionState, frames: readonly string[]): ChatConnectionState {
  return frames.reduce((current, raw) => applyServerFrame(current, raw, NOW), state)
}

test('snapshot then tail folds to exactly what the full stream folds to', () => {
  const before: AgentEvent[] = [
    { type: 'status', status: 'working' },
    { type: 'message', role: 'user', messageId: 'u1', text: 'do the thing' },
    assistantChunk('a1', 'first ')
  ]
  const after: AgentEvent[] = [assistantChunk('a1', 'half'), { type: 'turn_complete', stopReason: 'end_turn' }]

  const joined = applyServerFrame(
    initialChatConnectionState(),
    frame({ type: 'snapshot', state: foldAll(before) }),
    NOW
  )
  assert.equal(joined.phase, 'live')

  const settled = applyFrames(
    joined,
    after.map((event) => frame({ type: 'event', event }))
  )
  assert.deepEqual(settled.transcript, overWire(foldAll([...before, ...after])))
})

test('a rejoin snapshot replaces the transcript wholesale: no duplicated and no missing messages', () => {
  const stream: AgentEvent[] = [
    { type: 'message', role: 'user', messageId: 'u1', text: 'question' },
    assistantChunk('a1', 'partial answer')
  ]
  const joined = applyFrames(initialChatConnectionState(), [frame({ type: 'snapshot', state: foldAll(stream) })])

  // The connection dies mid-turn (phone lock, network blip); events kept flowing on the host.
  const dropped = connectionLost(joined)
  assert.equal(dropped.phase, 'reconnecting')
  assert.ok(dropped.transcript, 'the stale transcript stays visible while rejoining')

  const missedOnHost: AgentEvent[] = [
    assistantChunk('a1', ' finished during the drop'),
    { type: 'turn_complete', stopReason: 'end_turn' }
  ]
  const rejoined = applyFrames(dropped, [frame({ type: 'snapshot', state: foldAll([...stream, ...missedOnHost]) })])

  assert.equal(rejoined.phase, 'live')
  assert.deepEqual(rejoined.transcript, overWire(foldAll([...stream, ...missedOnHost])))
  assert.equal(rejoined.transcript?.messages.length, 2)
  assert.equal(rejoined.transcript?.messages[1]?.text, 'partial answer finished during the drop')
})

test('a mid-stream snapshot (host replay resync) also replaces rather than merges', () => {
  const live = applyFrames(initialChatConnectionState(), [
    frame({ type: 'snapshot', state: foldAll([]) }),
    frame({ type: 'event', event: assistantChunk('a1', 'live text') })
  ])

  const replayed = foldAll([
    { type: 'message', role: 'user', messageId: 'u0', text: 'restored question' },
    assistantChunk('a0', 'restored answer'),
    assistantChunk('a1', 'live text')
  ])
  const resynced = applyFrames(live, [frame({ type: 'snapshot', state: replayed })])

  assert.deepEqual(resynced.transcript, overWire(replayed))
})

test('an event arriving before any snapshot is dropped, never folded onto a gap', () => {
  const state = applyServerFrame(
    initialChatConnectionState(),
    frame({ type: 'event', event: assistantChunk('a1', 'orphan') }),
    NOW
  )
  assert.equal(state.transcript, null)
  assert.equal(state.phase, 'connecting')
})

test('an unparsable frame changes nothing', () => {
  const joined = applyFrames(initialChatConnectionState(), [frame({ type: 'snapshot', state: foldAll([]) })])
  assert.deepEqual(applyServerFrame(joined, 'not json', NOW), joined)
  assert.deepEqual(applyServerFrame(joined, frame({ type: 'mystery' }), NOW), joined)
  assert.deepEqual(applyServerFrame(joined, 12, NOW), joined)
})

test('a drop before the first snapshot stays "connecting" rather than claiming a rejoin', () => {
  const state = connectionLost(initialChatConnectionState())
  assert.equal(state.phase, 'connecting')
})

test('a chat the desktop no longer lists is gone, with the last transcript retained', () => {
  const joined = applyFrames(initialChatConnectionState(), [frame({ type: 'snapshot', state: foldAll([]) })])
  const gone = chatGone(joined)
  assert.equal(gone.phase, 'gone')
  assert.ok(gone.transcript)
})

test('reconnect delays grow and stay bounded', () => {
  assert.equal(reconnectDelayMs(0), 500)
  assert.ok(reconnectDelayMs(1) > reconnectDelayMs(0))
  assert.equal(reconnectDelayMs(10), 8_000)
  assert.equal(reconnectDelayMs(-1), 500)
})

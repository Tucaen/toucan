import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { createAgentEventBroker } from '../src/main/agent-event-broker'
import type { AgentEvent } from '../src/shared/agent'
import { foldAgentEvent, initialAgentTranscriptState, type AgentTranscriptState } from '../src/shared/agent-transcript'

const NOW = 1_700_000_000_000

function message(messageId: string, text: string): AgentEvent {
  return { type: 'message', role: 'assistant', messageId, text }
}

function foldAll(events: readonly AgentEvent[], from = initialAgentTranscriptState()): AgentTranscriptState {
  return events.reduce((state, event) => foldAgentEvent(state, event, NOW), from)
}

test('published events reach every subscriber of that session and no other', () => {
  const broker = createAgentEventBroker({ now: () => NOW })
  const first: AgentEvent[] = []
  const second: AgentEvent[] = []
  const elsewhere: AgentEvent[] = []
  broker.subscribe('node-1', (event) => first.push(event))
  broker.subscribe('node-1', (event) => second.push(event))
  broker.subscribe('node-2', (event) => elsewhere.push(event))

  broker.publish('node-1', { type: 'status', status: 'working' })
  broker.publish('node-1', message('a1', 'hello'))

  assert.deepEqual(first, [{ type: 'status', status: 'working' }, message('a1', 'hello')])
  assert.deepEqual(second, first)
  assert.deepEqual(elsewhere, [])
})

test('a late subscriber joins with snapshot plus gap-free tail even when events race the subscribe', () => {
  const broker = createAgentEventBroker({ now: () => NOW })
  const before: AgentEvent[] = [{ type: 'status', status: 'working' }, message('a1', 'first '), message('a1', 'half')]
  const after: AgentEvent[] = [message('a1', ' and tail'), { type: 'turn_complete', stopReason: 'end_turn' }]
  for (const event of before) broker.publish('node-1', event)

  const tail: AgentEvent[] = []
  const joined = broker.subscribe('node-1', (event) => tail.push(event))
  for (const event of after) broker.publish('node-1', event)

  // Snapshot + tail folds to exactly what folding the whole stream yields: nothing missed,
  // nothing duplicated, regardless of where the subscribe landed in the stream.
  assert.deepEqual(foldAll(tail, joined.snapshot), foldAll([...before, ...after]))
  assert.deepEqual(tail, after)
})

test('unsubscribe stops delivery without disturbing other subscribers', () => {
  const broker = createAgentEventBroker({ now: () => NOW })
  const kept: AgentEvent[] = []
  const dropped: AgentEvent[] = []
  broker.subscribe('node-1', (event) => kept.push(event))
  const leaver = broker.subscribe('node-1', (event) => dropped.push(event))

  broker.publish('node-1', message('a1', 'one'))
  leaver.unsubscribe()
  broker.publish('node-1', message('a1', 'two'))

  assert.deepEqual(dropped, [message('a1', 'one')])
  assert.deepEqual(kept, [message('a1', 'one'), message('a1', 'two')])
})

test('one throwing subscriber cannot starve the others of an event', () => {
  const broker = createAgentEventBroker({ now: () => NOW })
  const received: AgentEvent[] = []
  broker.subscribe('node-1', () => {
    throw new Error('renderer went away mid-send')
  })
  broker.subscribe('node-1', (event) => received.push(event))

  broker.publish('node-1', message('a1', 'still delivered'))

  assert.deepEqual(received, [message('a1', 'still delivered')])
})

test('replay events fold into the snapshot without fanning out live', () => {
  const broker = createAgentEventBroker({ now: () => NOW })
  const live: AgentEvent[] = []
  broker.subscribe('node-1', (event) => live.push(event))

  broker.fold('node-1', message('replay-1', 'restored text'))

  assert.deepEqual(live, [])
  assert.equal(broker.snapshot('node-1')?.messages[0]?.text, 'restored text')
})

test('the create result settles the snapshot the same way the renderer settles its transcript', () => {
  const broker = createAgentEventBroker({ now: () => NOW })
  broker.fold('node-1', { type: 'message', role: 'user', messageId: 'u1', text: 'question' })
  broker.fold('node-1', message('a1', 'replayed answer'))

  broker.applyCreateResult('node-1', { ok: true, status: 'ready', sessionId: 's-1' })

  const snapshot = broker.snapshot('node-1')
  assert.equal(snapshot?.status, 'ready')
  assert.equal(snapshot?.sessionId, 's-1')
  // Replayed assistant turns settle as complete/final, exactly as `applyAgentCreateResult` does.
  assert.equal(snapshot?.messages[1]?.complete, true)
})

test('closing a session drops its snapshot and its subscribers', () => {
  const broker = createAgentEventBroker({ now: () => NOW })
  const seen: AgentEvent[] = []
  broker.subscribe('node-1', (event) => seen.push(event))
  broker.publish('node-1', message('a1', 'before close'))

  broker.close('node-1')
  broker.publish('node-1', message('a1', 'after close'))

  assert.deepEqual(seen, [message('a1', 'before close')])
  assert.equal(broker.snapshot('node-1')?.messages[0]?.text, 'after close')
})

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  applyServerFrame,
  beginSend,
  canSendDraft,
  chatGone,
  connectionLost,
  DISCONNECTED_WHILE_SENDING,
  draftChanged,
  initialChatConnectionState,
  plannedSend,
  reconnectDelayMs,
  restoredChatConnectionState,
  sendBlockedReason,
  sendFailed,
  withSend,
  type ChatConnectionState
} from '../mobile/src/chat-connection'
import type { AgentEvent } from '../src/shared/agent'
import { foldAgentEvent, initialAgentTranscriptState, type AgentTranscriptState } from '../src/shared/agent-transcript'
import { promptTextProblem, REMOTE_CHAT_PROMPT_LIMIT } from '../src/shared/remote-chat'

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
  const joined = applyFrames(initialChatConnectionState(), [
    frame({ type: 'snapshot', state: foldAll([]) }),
    frame({ type: 'event', event: assistantChunk('a1', 'live text') })
  ])

  const replayed = foldAll([
    { type: 'message', role: 'user', messageId: 'u0', text: 'restored question' },
    assistantChunk('a0', 'restored answer'),
    assistantChunk('a1', 'live text')
  ])
  const resynced = applyFrames(joined, [frame({ type: 'snapshot', state: replayed })])

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

/**
 * The other direction: sending. The property under test is the ticket's own rule - a prompt is
 * never silently dropped and never accidentally steered - which on the phone means a working
 * session is not a send target, and what was typed survives every way a send can fail.
 */

function live(events: readonly AgentEvent[] = []): ChatConnectionState {
  return applyFrames(initialChatConnectionState(), [frame({ type: 'snapshot', state: foldAll(events) })])
}

const READY: AgentEvent[] = [{ type: 'status', status: 'idle' }]

test('an idle live session accepts a draft and clears it once the host confirms the turn', () => {
  const typed = draftChanged(live(READY), 'ship it')
  assert.equal(sendBlockedReason(typed), null)
  assert.equal(canSendDraft(typed), true)

  const sending = beginSend(typed, 'r1')
  assert.deepEqual(sending.send, { status: 'sending', requestId: 'r1', text: 'ship it' })
  // Out of the composer immediately, so a double tap cannot send it twice.
  assert.equal(sending.draft, '')
  assert.equal(canSendDraft(sending), false)

  const confirmed = applyServerFrame(sending, frame({ type: 'prompt_result', requestId: 'r1', ok: true }), NOW)
  assert.deepEqual(confirmed.send, { status: 'idle' })
  assert.equal(confirmed.draft, '')
  // The message itself arrives as the provider's echo, not as a local copy: no optimistic bubble.
  assert.equal(confirmed.transcript?.messages.length, 0)
})

test('the sent message reaches the transcript only as the echoed event, exactly once', () => {
  const sending = beginSend(draftChanged(live(READY), 'ship it'), 'r1')
  const echoed = applyFrames(sending, [
    frame({ type: 'prompt_result', requestId: 'r1', ok: true }),
    frame({ type: 'event', event: { type: 'message', role: 'user', messageId: 'u1', text: 'ship it' } }),
    frame({ type: 'event', event: { type: 'status', status: 'working' } })
  ])
  assert.deepEqual(
    echoed.transcript?.messages.map((message) => [message.role, message.text]),
    [['user', 'ship it']]
  )
})

test('a working session is blocked with a hint rather than queued or steered', () => {
  const working = draftChanged(live([{ type: 'status', status: 'working' }]), 'and also this')
  assert.match(sendBlockedReason(working) ?? '', /Working/)
  assert.equal(canSendDraft(working), false)
  // Blocked means the draft is untouched: nothing is held in a hidden queue on the phone.
  assert.deepEqual(beginSend(working, 'r1'), working)
  assert.equal(working.draft, 'and also this')
})

test('a session that is not live, exited, or waiting on an answer is never a send target', () => {
  const typed = (state: ChatConnectionState): ChatConnectionState => draftChanged(state, 'hello')
  assert.match(sendBlockedReason(typed(connectionLost(live(READY)))) ?? '', /Not connected/)
  assert.match(sendBlockedReason(typed(chatGone(live(READY)))) ?? '', /no longer open/)
  assert.match(sendBlockedReason(typed(live([{ type: 'status', status: 'exited' }]))) ?? '', /exited/)
  assert.match(sendBlockedReason(typed(live([{ type: 'status', status: 'auth_required' }]))) ?? '', /signing in/)
  assert.match(
    sendBlockedReason(
      typed(
        live([
          ...READY,
          {
            type: 'approval',
            approvalId: 'p1',
            title: 'Run tests',
            options: [{ id: 'allow', label: 'Allow', kind: 'allow_once' }]
          }
        ])
      )
    ) ?? '',
    /on the desktop/
  )
})

test('an empty or oversized draft is refused before it reaches the socket', () => {
  assert.equal(canSendDraft(draftChanged(live(READY), '   ')), false)
  assert.equal(promptTextProblem('   '), 'Type a message first.')
  assert.match(promptTextProblem('x'.repeat(REMOTE_CHAT_PROMPT_LIMIT + 1)) ?? '', /at most/)
  assert.equal(promptTextProblem('x'.repeat(REMOTE_CHAT_PROMPT_LIMIT)), null)
})

test('a refused send reports the host reason and hands the text back to the composer', () => {
  const sending = beginSend(draftChanged(live(READY), 'ship it'), 'r1')
  const refused = applyServerFrame(
    sending,
    frame({ type: 'prompt_result', requestId: 'r1', ok: false, message: 'The agent session is busy.' }),
    NOW
  )
  assert.deepEqual(refused.send, { status: 'failed', message: 'The agent session is busy.' })
  assert.equal(refused.draft, 'ship it')

  // Typing acknowledges the notice rather than leaving it up forever.
  assert.deepEqual(draftChanged(refused, 'ship it now').send, { status: 'idle' })
})

test('a drop mid-send reports the message as unconfirmed and preserves the text', () => {
  const sending = beginSend(draftChanged(live(READY), 'ship it'), 'r1')
  const dropped = connectionLost(sending)
  assert.equal(dropped.phase, 'reconnecting')
  assert.deepEqual(dropped.send, { status: 'failed', message: DISCONNECTED_WHILE_SENDING })
  assert.equal(dropped.draft, 'ship it')

  // A verdict for that abandoned send arriving late must not resurrect it as in-flight.
  assert.deepEqual(applyServerFrame(dropped, frame({ type: 'prompt_result', requestId: 'r1', ok: true }), NOW), dropped)
})

test('a verdict for some other send is ignored', () => {
  const sending = beginSend(draftChanged(live(READY), 'ship it'), 'r1')
  assert.deepEqual(
    applyServerFrame(sending, frame({ type: 'prompt_result', requestId: 'r0', ok: false }), NOW),
    sending
  )
})

test('text typed while a send was in flight outranks the recovered draft', () => {
  const sending = beginSend(draftChanged(live(READY), 'first'), 'r1')
  const retyped = draftChanged(sending, 'second')
  const refused = sendFailed(retyped, 'nope')
  assert.equal(refused.draft, 'second')
  assert.deepEqual(refused.send, { status: 'failed', message: 'nope' })
})

test('a rejoin snapshot keeps an unsent draft and its failure notice', () => {
  const dropped = connectionLost(beginSend(draftChanged(live(READY), 'ship it'), 'r1'))
  const rejoined = applyFrames(dropped, [frame({ type: 'snapshot', state: foldAll(READY) })])
  assert.equal(rejoined.phase, 'live')
  assert.equal(rejoined.draft, 'ship it')
  assert.deepEqual(rejoined.send, { status: 'failed', message: DISCONNECTED_WHILE_SENDING })
})

test('a planned send applies onto whatever state has since arrived, because the frame is already sent', () => {
  const typed = draftChanged(live(READY), 'ship it')
  const planned = plannedSend(typed, 'r1')
  assert.ok(planned)
  assert.deepEqual(planned, { status: 'sending', requestId: 'r1', text: 'ship it' })

  // Between deciding and writing, the host's own echo of a desktop send arrives. The composer
  // still has to clear and the slot still has to hold the verdict: the prompt is on the wire.
  const meanwhile = applyServerFrame(
    typed,
    frame({ type: 'event', event: { type: 'message', role: 'user', messageId: 'u9', text: 'from the desktop' } }),
    NOW
  )
  const applied = withSend(meanwhile, planned)
  assert.equal(applied.draft, '')
  assert.deepEqual(applied.send, planned)
  assert.equal(applied.transcript?.messages.at(-1)?.text, 'from the desktop')

  // And the verdict for it still correlates, so the send cannot be left hanging.
  const confirmed = applyServerFrame(applied, frame({ type: 'prompt_result', requestId: 'r1', ok: true }), NOW)
  assert.deepEqual(confirmed.send, { status: 'idle' })
})

test('a state restored from device retention comes back with the draft and nothing else', () => {
  // The 401-after-revoke path unmounts the chat screen on its way to pairing; this is what makes
  // the typed text survive it.
  const restored = restoredChatConnectionState('ship it')
  assert.equal(restored.draft, 'ship it')
  assert.equal(restored.transcript, null)
  assert.equal(restored.phase, 'connecting')
  assert.deepEqual(restored.send, { status: 'idle' })
  // Not sendable until the rejoin lands, and it says why rather than looking broken.
  assert.match(sendBlockedReason(restored) ?? '', /Not connected/)
})

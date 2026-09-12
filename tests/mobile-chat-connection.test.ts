import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  answerBlockedReason,
  answerFailed,
  answerFailure,
  answerInFlight,
  applyServerFrame,
  beginSend,
  canSendDraft,
  chatGone,
  chatModels,
  composerHidden,
  connectionLost,
  currentModel,
  DISCONNECTED_WHILE_ANSWERING,
  DISCONNECTED_WHILE_SENDING,
  DISCONNECTED_WHILE_SWITCHING,
  draftChanged,
  initialChatConnectionState,
  modelChangeBlockedReason,
  modelChangeFailed,
  modelChangeFailure,
  modelChangeInFlight,
  modelPickerBlockedReason,
  pendingRequest,
  plannedAnswer,
  plannedModelChange,
  plannedSend,
  readReportKey,
  reconnectDelayMs,
  restoredChatConnectionState,
  sendBlockedReason,
  sendFailed,
  withAnswer,
  withModelChange,
  withSend,
  type ChatConnectionState
} from '../mobile/src/chat-connection'
import { MODEL_CHANGE_WHILE_BUSY, type AgentDecisionRequest, type AgentEvent } from '../src/shared/agent'
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
  const parked = typed(live([...READY, APPROVAL]))
  assert.match(sendBlockedReason(parked) ?? '', /Answer the request/)
  // Not merely blocked: while a request stands there is no composer to type into at all.
  assert.equal(composerHidden(parked), true)
  assert.equal(composerHidden(typed(live(READY))), false)
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

/**
 * Answering, from the phone's side. The rules under test are the ones that keep two clients from
 * disagreeing about one request: only what the transcript says is pending may be answered, only
 * one answer may be in flight, a refusal is reported against the request it was about and not the
 * next one, and a resolution the *other* client caused retires the card here too - the phone never
 * decides that on its own.
 */

const APPROVAL: AgentEvent = {
  type: 'approval',
  approvalId: 'p1',
  title: 'Run npm test',
  options: [
    { id: 'allow', label: 'Allow', kind: 'allow_once' },
    { id: 'reject', label: 'Reject', kind: 'reject_once' }
  ]
}

const QUESTIONS: AgentDecisionRequest = {
  id: 'd1',
  message: 'Please answer the following questions.',
  questions: [
    {
      id: 'scope',
      title: 'Scope',
      question: 'Read-only first?',
      options: [
        { value: 'Read-only', label: 'Read-only' },
        { value: 'Complete CRUD', label: 'Complete CRUD' }
      ],
      input: 'select',
      multiSelect: false,
      required: true,
      customAnswerId: 'scope_custom'
    },
    {
      id: 'note',
      question: 'Anything else?',
      options: [],
      input: 'text',
      multiSelect: false
    }
  ]
}

const DECISION: AgentEvent = { type: 'decision_request', request: QUESTIONS }

test('a pending approval is what the phone presents, and it outranks a queued question set', () => {
  assert.equal(pendingRequest(live(READY)), null)

  const both = live([...READY, DECISION, APPROVAL])
  const pending = pendingRequest(both)
  assert.equal(pending?.kind, 'approval')
  assert.equal(pending?.id, 'p1')
  assert.deepEqual(pending?.kind === 'approval' ? pending.options.map((option) => option.id) : [], ['allow', 'reject'])

  // With the approval answered, the question set behind it is the one presented - the head of it,
  // never two at once.
  const queued = live([...READY, DECISION, { type: 'decision_request', request: { ...QUESTIONS, id: 'd2' } }])
  const next = pendingRequest(queued)
  assert.equal(next?.kind, 'decision')
  assert.equal(next?.id, 'd1')
})

test('only the pending request may be answered, and only one answer at a time', () => {
  const parked = live([...READY, APPROVAL])
  assert.equal(answerBlockedReason(parked, 'p1'), null)
  // A working session is never a reason to refuse the answer that would unblock it.
  assert.equal(answerBlockedReason(live([{ type: 'status', status: 'working' }, APPROVAL]), 'p1'), null)
  assert.match(answerBlockedReason(parked, 'stale-id') ?? '', /no longer pending/)
  assert.match(answerBlockedReason(connectionLost(parked), 'p1') ?? '', /Not connected/)
  assert.match(answerBlockedReason(chatGone(parked), 'p1') ?? '', /no longer open/)

  const answering = withAnswer(parked, plannedAnswer(parked, 'r1', 'p1')!)
  assert.equal(answerInFlight(answering), true)
  assert.match(answerBlockedReason(answering, 'p1') ?? '', /Answering/)
  assert.equal(plannedAnswer(answering, 'r2', 'p1'), null)
})

test('an accepted answer clears the slot, and the card retires on the session event, not locally', () => {
  const parked = live([...READY, APPROVAL])
  const answering = withAnswer(parked, plannedAnswer(parked, 'r1', 'p1')!)

  const accepted = applyServerFrame(answering, frame({ type: 'answer_result', requestId: 'r1', ok: true }), NOW)
  assert.deepEqual(accepted.answer, { status: 'idle' })
  // Still pending: the phone does not get to decide the request is over.
  assert.equal(pendingRequest(accepted)?.id, 'p1')

  const resolved = applyServerFrame(
    accepted,
    frame({ type: 'event', event: { type: 'approval_resolved', approvalId: 'p1' } }),
    NOW
  )
  assert.equal(pendingRequest(resolved), null)
  assert.equal(composerHidden(resolved), false)
})

test('losing the race is reported on the card, and the card resolves rather than double-answering', () => {
  const parked = live([...READY, APPROVAL])
  const answering = withAnswer(parked, plannedAnswer(parked, 'r1', 'p1')!)

  const refused = applyServerFrame(
    answering,
    frame({ type: 'answer_result', requestId: 'r1', ok: false, message: 'That request was already answered.' }),
    NOW
  )
  assert.match(answerFailure(refused) ?? '', /already answered/)
  assert.equal(answerInFlight(refused), false)

  // The winner's resolution reaches every client as the session's own event; the loser's card goes
  // with it, and its notice goes too rather than following the reader to the next request.
  const resolved = applyServerFrame(
    refused,
    frame({ type: 'event', event: { type: 'approval_resolved', approvalId: 'p1' } }),
    NOW
  )
  assert.equal(pendingRequest(resolved), null)
  assert.equal(answerFailure(resolved), null)
})

test('a refusal notice does not carry over onto the next request to arrive', () => {
  const parked = live([...READY, APPROVAL])
  const refused = applyServerFrame(
    withAnswer(parked, plannedAnswer(parked, 'r1', 'p1')!),
    frame({ type: 'answer_result', requestId: 'r1', ok: false, message: 'That request was already answered.' }),
    NOW
  )
  const nextRequest = applyFrames(refused, [
    frame({ type: 'event', event: { type: 'approval_resolved', approvalId: 'p1' } }),
    frame({
      type: 'event',
      event: { ...APPROVAL, approvalId: 'p2', title: 'Delete file: src/gone.ts' }
    })
  ])
  assert.equal(pendingRequest(nextRequest)?.id, 'p2')
  assert.equal(answerFailure(nextRequest), null)
  assert.equal(answerBlockedReason(nextRequest, 'p2'), null)
})

test('a verdict for a superseded answer is ignored', () => {
  const parked = live([...READY, APPROVAL])
  const answering = withAnswer(parked, plannedAnswer(parked, 'r1', 'p1')!)
  const other = applyServerFrame(answering, frame({ type: 'answer_result', requestId: 'r9', ok: false }), NOW)
  assert.deepEqual(other, answering)
})

test('a drop mid-answer reports it as unconfirmed rather than as sent', () => {
  const parked = live([...READY, APPROVAL])
  const dropped = connectionLost(withAnswer(parked, plannedAnswer(parked, 'r1', 'p1')!))
  assert.equal(dropped.phase, 'reconnecting')
  assert.equal(answerFailure(dropped), DISCONNECTED_WHILE_ANSWERING)
  // The rejoin's snapshot is the only trustworthy answer to "did it land": here it still stands.
  assert.equal(pendingRequest(dropped)?.id, 'p1')
})

test('an answer that never reached the socket is reported, not assumed delivered', () => {
  const parked = live([...READY, APPROVAL])
  const failed = answerFailed(withAnswer(parked, plannedAnswer(parked, 'r1', 'p1')!), 'Not connected.')
  assert.equal(answerFailure(failed), 'Not connected.')
  assert.equal(answerInFlight(failed), false)
})

test('a question set hides the composer exactly like an approval does', () => {
  const parked = live([...READY, DECISION])
  assert.equal(composerHidden(parked), true)
  assert.match(sendBlockedReason(draftChanged(parked, 'hello')) ?? '', /Answer the request/)

  const resolved = applyServerFrame(
    parked,
    frame({ type: 'event', event: { type: 'decision_resolved', requestId: 'd1' } }),
    NOW
  )
  assert.equal(composerHidden(resolved), false)
  assert.equal(sendBlockedReason(draftChanged(resolved, 'hello')), null)
})

/**
 * When this reader tells the host they have read the chat. Two moments and no more: arriving, and
 * something landing while they are still here. A key that changed is the whole trigger, so what is
 * asserted is which transitions move it - and, just as load-bearing, which ones do not, because a
 * key that moved per streamed chunk would report a read per frame of a turn.
 */

test('arriving at a live chat is worth reporting, and a stream of chunks is not', () => {
  assert.equal(readReportKey(initialChatConnectionState()), null)

  const joined = live(READY)
  const arrived = readReportKey(joined)
  assert.ok(arrived)

  const streaming = applyFrames(joined, [
    frame({ type: 'event', event: { type: 'status', status: 'working' } }),
    frame({ type: 'event', event: assistantChunk('a1', 'thinking ') }),
    frame({ type: 'event', event: assistantChunk('a1', 'out loud') })
  ])
  const midTurn = readReportKey(streaming)
  assert.notEqual(midTurn, arrived)
  // Every chunk after the first leaves it exactly where the turn's start put it.
  assert.equal(
    readReportKey(applyFrames(streaming, [frame({ type: 'event', event: assistantChunk('a1', ' and on') })])),
    midTurn
  )

  // The turn ending is what raises a result on the canvas, so it is what a reader present for it
  // has to clear - and it is not the key they arrived on either, because the turn left something
  // behind that a reader arriving now would not have seen.
  const finished = applyFrames(streaming, [frame({ type: 'event', event: { type: 'status', status: 'idle' } })])
  assert.notEqual(readReportKey(finished), midTurn)
  assert.notEqual(readReportKey(finished), arrived)
})

test('a failure raised while the reader is here moves the key, and a second look does not', () => {
  const failed = applyFrames(live(READY), [
    frame({ type: 'event', event: { type: 'turn_failed', turnId: 't1', message: 'the adapter died' } })
  ])
  assert.notEqual(readReportKey(failed), readReportKey(live(READY)))
  assert.equal(readReportKey(applyFrames(failed, [])), readReportKey(failed))
})

test('a transcript that is not live has nothing to report', () => {
  const dropped = connectionLost(live(READY))
  assert.equal(readReportKey(dropped), null)
  assert.equal(readReportKey(chatGone(live(READY))), null)

  // A rejoin that changed nothing reports the same key, which is what stops a flapping socket from
  // reporting a read the reader never made twice over.
  const rejoined = applyFrames(dropped, [frame({ type: 'snapshot', state: foldAll(READY) })])
  assert.equal(readReportKey(rejoined), readReportKey(live(READY)))
})

test('a whole turn that ran while the socket was down is not mistaken for nothing happening', () => {
  const dropped = connectionLost(live(READY))

  // The canvas raised a result for this turn while the phone was away; the reader comes back to a
  // settled session with no failure - indistinguishable from where they left off, but for what
  // arrived in between.
  const missed = foldAll(
    [
      { type: 'status', status: 'working' },
      { type: 'message', role: 'assistant', messageId: 'a1', text: 'done while you were away' },
      { type: 'turn_complete', stopReason: 'end_turn' },
      { type: 'status', status: 'idle' }
    ],
    foldAll(READY)
  )
  const rejoined = applyFrames(dropped, [frame({ type: 'snapshot', state: missed })])
  assert.notEqual(readReportKey(rejoined), readReportKey(live(READY)))
})

/**
 * Choosing a model, from the phone's side. The rule the tests are really about is that nothing
 * here is optimistic: the selection shown is always the session's own, so a pick that is refused,
 * lost to a drop, or simply not acted on by the adapter cannot leave the phone displaying a model
 * the conversation is not running on.
 */

const MODELS: AgentEvent = {
  type: 'models',
  models: {
    currentModelId: 'sonnet',
    availableModels: [
      { id: 'sonnet', name: 'Sonnet' },
      { id: 'opus', name: 'Opus', description: 'The slow careful one' }
    ]
  }
}

const WITH_MODELS: AgentEvent[] = [...READY, MODELS]

test('the model the session reports is the model the phone shows', () => {
  const state = live(WITH_MODELS)
  assert.deepEqual(currentModel(state), { id: 'sonnet', name: 'Sonnet' })
  assert.equal(chatModels(state)?.availableModels.length, 2)

  // A session that advertises no model choice renders nothing rather than an empty picker, and
  // says why for any caller that asks.
  assert.equal(chatModels(live(READY)), null)
  assert.equal(currentModel(live(READY)), null)
  assert.match(modelPickerBlockedReason(live(READY)) ?? '', /does not offer a model choice/)
})

test('a model the session never advertised, and the one already selected, are not pickable', () => {
  const state = live(WITH_MODELS)
  assert.equal(modelChangeBlockedReason(state, 'opus'), null)
  assert.match(modelChangeBlockedReason(state, 'gpt-5') ?? '', /unavailable/)
  assert.match(modelChangeBlockedReason(state, 'sonnet') ?? '', /already selected/)
  assert.equal(plannedModelChange(state, 'r1', 'gpt-5'), null)
})

test('the picker is closed while starting, exited, or mid-turn', () => {
  const starting = live([{ type: 'status', status: 'starting' }, MODELS])
  assert.match(modelPickerBlockedReason(starting) ?? '', /still starting/)

  const exited = live([{ type: 'status', status: 'exited' }, MODELS])
  assert.match(modelPickerBlockedReason(exited) ?? '', /has exited/)

  // A conversation keeps one model for a whole turn, and the phone says so in the host's own
  // words - `setModel` refuses a busy session with this exact string, so the greyed-out control
  // and the refusal behind it cannot describe two different rules.
  const working = live([{ type: 'status', status: 'working' }, MODELS])
  assert.equal(modelPickerBlockedReason(working), MODEL_CHANGE_WHILE_BUSY)
  assert.equal(plannedModelChange(working, 'r1', 'opus'), null)

  // Idle is the whole point of the rule: the change is available the moment the turn ends.
  assert.equal(modelChangeBlockedReason(live(WITH_MODELS), 'opus'), null)
})

test('a change in flight is inert and says so, and the new selection comes from the session', () => {
  const planned = plannedModelChange(live(WITH_MODELS), 'r1', 'opus')
  assert.deepEqual(planned, { status: 'selecting', requestId: 'r1', modelId: 'opus' })
  const selecting = withModelChange(live(WITH_MODELS), planned!)

  assert.equal(modelChangeInFlight(selecting), true)
  assert.match(modelPickerBlockedReason(selecting) ?? '', /Switching/)
  // Still Sonnet: the pick has been asked for, not applied.
  assert.deepEqual(currentModel(selecting), { id: 'sonnet', name: 'Sonnet' })

  const accepted = applyServerFrame(selecting, frame({ type: 'model_result', requestId: 'r1', ok: true }), NOW)
  assert.deepEqual(accepted.model, { status: 'idle' })
  // Acceptance alone does not move the selection either; the session's own event does.
  assert.deepEqual(currentModel(accepted), { id: 'sonnet', name: 'Sonnet' })

  const applied = applyFrames(accepted, [
    frame({
      type: 'event',
      event: {
        type: 'models',
        models: {
          currentModelId: 'opus',
          availableModels: MODELS.type === 'models' ? MODELS.models.availableModels : []
        }
      }
    })
  ])
  assert.deepEqual(currentModel(applied), { id: 'opus', name: 'Opus', description: 'The slow careful one' })
})

test('a refused change reports the host reason and re-opens the picker', () => {
  const selecting = withModelChange(live(WITH_MODELS), plannedModelChange(live(WITH_MODELS), 'r1', 'opus')!)
  const refused = applyServerFrame(
    selecting,
    frame({
      type: 'model_result',
      requestId: 'r1',
      ok: false,
      message: 'This agent does not expose model selection.'
    }),
    NOW
  )
  assert.equal(modelChangeFailure(refused), 'This agent does not expose model selection.')
  assert.equal(modelChangeInFlight(refused), false)
  // Retryable, because most refusals are transient and the host refuses a second bad one anyway.
  assert.equal(modelChangeBlockedReason(refused, 'opus'), null)
})

test('a verdict for a superseded model change is ignored', () => {
  const selecting = withModelChange(live(WITH_MODELS), plannedModelChange(live(WITH_MODELS), 'r1', 'opus')!)
  const other = applyServerFrame(selecting, frame({ type: 'model_result', requestId: 'r9', ok: false }), NOW)
  assert.deepEqual(other.model, selecting.model)
})

test('a drop mid-change reports it as unconfirmed and points at the reconnected truth', () => {
  const selecting = withModelChange(live(WITH_MODELS), plannedModelChange(live(WITH_MODELS), 'r1', 'opus')!)
  const dropped = connectionLost(selecting)
  assert.equal(modelChangeFailure(dropped), DISCONNECTED_WHILE_SWITCHING)

  // And a change that never reached the socket at all is reported the same way, not assumed sent.
  assert.equal(modelChangeFailed(selecting, 'Not connected.').model.status, 'failed')
})

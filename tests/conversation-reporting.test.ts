import { strict as assert } from 'node:assert'
import { describe, it } from 'vitest'
import type { AttentionAction, AttentionSignal } from '../src/shared/attention'
import {
  STALL_THRESHOLD_MS,
  authAttentionAction,
  failureAttentionAction,
  generatedConversationTitle,
  initialTicketTurnTracking,
  initialTurnResultTracking,
  isStalled,
  pendingRequestActions,
  sidebarStatus,
  ticketActivityDigest,
  trackTicketTurn,
  trackTurnResult,
  type ReportingIdentity,
  type TurnResultTracking
} from '../src/renderer/src/conversation-reporting'
import type { AgentChatMessage } from '../src/shared/agent-transcript'

const identity: ReportingIdentity = { nodeId: 'node-1', label: 'Fix the tests', sourceId: 'conv-1' }

/** Unwraps a raise action's signal, failing the test for any other action. */
function raiseSignal(action: AttentionAction | null | undefined): Omit<AttentionSignal, 'at'> {
  assert.ok(action, 'expected an attention action')
  assert.equal(action.type, 'raise')
  return (action as Extract<AttentionAction, { type: 'raise' }>).signal
}

function message(overrides: Partial<AgentChatMessage> & Pick<AgentChatMessage, 'id' | 'role'>): AgentChatMessage {
  return { text: 'hello', ...overrides }
}

describe('sidebarStatus', () => {
  it('maps live states directly', () => {
    assert.equal(sidebarStatus('exited', false, undefined, false), 'exited')
    assert.equal(sidebarStatus('starting', false, undefined, false), 'starting')
    assert.equal(sidebarStatus('working', false, undefined, false), 'working')
    assert.equal(sidebarStatus('working', false, undefined, true), 'stalled')
    assert.equal(sidebarStatus('ready', false, undefined, false), 'idle')
  })

  it('reports attention for auth or a pending request', () => {
    assert.equal(sidebarStatus('auth_required', false, undefined, false), 'attention')
    assert.equal(sidebarStatus('ready', true, undefined, false), 'attention')
  })

  it('reads a blocking unread record back as attention, an ordinary one as result', () => {
    assert.equal(sidebarStatus('ready', false, 'approval', false), 'attention')
    assert.equal(sidebarStatus('ready', false, 'auth', false), 'attention')
    assert.equal(sidebarStatus('ready', false, 'failure', false), 'attention')
    assert.equal(sidebarStatus('ready', false, 'result', false), 'result')
    assert.equal(sidebarStatus('ready', false, 'output', false), 'result')
  })
})

describe('isStalled', () => {
  it('flags only progress silence beyond the threshold', () => {
    const start = 1_000_000
    assert.equal(isStalled(start + STALL_THRESHOLD_MS, start), false)
    assert.equal(isStalled(start + STALL_THRESHOLD_MS + 1, start), true)
  })
})

describe('trackTurnResult', () => {
  const finished = (state: TurnResultTracking, messages: AgentChatMessage[], selected = false) =>
    trackTurnResult(state, identity, { status: 'ready', messages, selected })

  it('raises a result for the answer a finished turn produced while unselected', () => {
    const before = [message({ id: 'a1', role: 'assistant', text: 'old answer' })]
    const working = trackTurnResult(initialTurnResultTracking, identity, {
      status: 'working',
      messages: before,
      selected: false
    })
    assert.equal(working.raise, null)
    const after = [...before, message({ id: 'a2', role: 'assistant', text: 'new answer' })]
    const done = finished(working.state, after)
    const signal = raiseSignal(done.raise)
    assert.equal(signal.kind, 'result')
    assert.equal(signal.nodeId, 'node-1')
    assert.equal(signal.sourceId, 'conv-1')
    assert.equal(signal.summary, 'Fix the tests finished a turn')
    // Keyed by the answer itself, so a replayed transcript lands on the same record.
    const replayed = finished(working.state, after)
    assert.deepEqual(replayed.raise, done.raise)
  })

  it('stays quiet while the node is selected', () => {
    const working = trackTurnResult(initialTurnResultTracking, identity, {
      status: 'working',
      messages: [],
      selected: false
    })
    const done = finished(working.state, [message({ id: 'a1', role: 'assistant' })], true)
    assert.equal(done.raise, null)
  })

  it('ignores answers that predate the turn and progress-only turns', () => {
    const before = [message({ id: 'a1', role: 'assistant', text: 'earlier' })]
    // The idle render sees the historical answer before the turn begins, as it does live.
    const idle = trackTurnResult(initialTurnResultTracking, identity, {
      status: 'ready',
      messages: before,
      selected: false
    })
    const working = trackTurnResult(idle.state, identity, {
      status: 'working',
      messages: before,
      selected: false
    })
    // No new final answer: the progress message never promotes.
    const progressOnly = [...before, message({ id: 'p1', role: 'assistant', presentation: 'progress' })]
    assert.equal(finished(working.state, progressOnly).raise, null)
  })

  it('does not raise on a ready render that follows no working turn', () => {
    const state = { ...initialTurnResultTracking, previousStatus: 'ready' as const }
    assert.equal(finished(state, [message({ id: 'a1', role: 'assistant' })]).raise, null)
  })

  it('takes the turn-start answer count from before the turn began', () => {
    // Two answers exist, both from history; the turn produces none, so nothing raises even
    // though the count moved between renders while working.
    const history = [message({ id: 'a1', role: 'assistant' }), message({ id: 'a2', role: 'assistant' })]
    const first = trackTurnResult(initialTurnResultTracking, identity, {
      status: 'ready',
      messages: history,
      selected: false
    })
    const working = trackTurnResult(first.state, identity, { status: 'working', messages: history, selected: false })
    assert.equal(working.state.turnStartFinalAnswerCount, 2)
    assert.equal(finished(working.state, history).raise, null)
  })
})

describe('pendingRequestActions', () => {
  it('raises the standing request keyed by its ACP id', () => {
    const actions = pendingRequestActions(null, { id: 'req-1', title: 'Run npm test?' }, identity)
    assert.deepEqual(actions, [
      {
        type: 'raise',
        signal: {
          nodeId: 'node-1',
          kind: 'approval',
          key: 'req-1',
          sourceId: 'conv-1',
          summary: 'Run npm test?'
        }
      }
    ])
  })

  it('falls back to a generic summary when the request has no title', () => {
    const [action] = pendingRequestActions(null, { id: 'req-1' }, identity)
    assert.equal(raiseSignal(action).summary, 'Fix the tests needs approval')
  })

  it('resolves the previous request when a new one replaces it', () => {
    const actions = pendingRequestActions('req-1', { id: 'req-2' }, identity)
    assert.equal(actions.length, 2)
    assert.deepEqual(actions[0], { type: 'resolve', nodeId: 'node-1', kind: 'approval', key: 'req-1' })
    assert.equal(raiseSignal(actions[1]).key, 'req-2')
  })

  it('only resolves when the request went away', () => {
    assert.deepEqual(pendingRequestActions('req-1', null, identity), [
      { type: 'resolve', nodeId: 'node-1', kind: 'approval', key: 'req-1' }
    ])
    assert.deepEqual(pendingRequestActions(null, null, identity), [])
  })

  it('re-reports the same standing request without resolving it', () => {
    const actions = pendingRequestActions('req-1', { id: 'req-1' }, identity)
    assert.equal(actions.length, 1)
    assert.equal(actions[0].type, 'raise')
  })
})

describe('authAttentionAction', () => {
  it('raises while sign-in is required and resolves once it is not', () => {
    const signal = raiseSignal(authAttentionAction(true, identity))
    assert.equal(signal.kind, 'auth')
    assert.equal(signal.key, 'auth')
    assert.equal(signal.summary, 'Fix the tests needs you to sign in')
    assert.deepEqual(authAttentionAction(false, identity), { type: 'resolve', nodeId: 'node-1', kind: 'auth' })
  })
})

describe('failureAttentionAction', () => {
  it('keys a failure by its reported key, falling back to a text digest', () => {
    const keyed = raiseSignal(failureAttentionAction('boom', 'turn-7', identity))
    assert.equal(keyed.key, 'turn-7')
    assert.equal(keyed.summary, 'boom')
    const digested = raiseSignal(failureAttentionAction('boom', null, identity))
    const again = raiseSignal(failureAttentionAction('boom', null, identity))
    assert.equal(digested.key, again.key)
  })

  it('reports nothing without a failure', () => {
    assert.equal(failureAttentionAction(null, null, identity), null)
  })
})

describe('generatedConversationTitle', () => {
  it('titles from the dialogue, ignoring thoughts and progress prose', () => {
    const title = generatedConversationTitle([
      message({ id: 'u1', role: 'user', text: 'Rename the widget module' }),
      message({ id: 't1', role: 'thought', text: 'thinking about widgets' }),
      message({ id: 'p1', role: 'assistant', text: 'Scanning files…', presentation: 'progress' }),
      message({ id: 'a1', role: 'assistant', text: 'Renamed it.' })
    ])
    assert.equal(title, 'Rename the widget module')
  })

  it('returns null before any final assistant answer exists', () => {
    assert.equal(
      generatedConversationTitle([message({ id: 'u1', role: 'user', text: 'Rename the widget module' })]),
      null
    )
  })
})

describe('trackTicketTurn', () => {
  it('pins the turn start on the idle-to-working edge and keeps it afterwards', () => {
    const working = trackTicketTurn(initialTicketTurnTracking, { working: true, transcriptLength: 4 })
    assert.deepEqual(working, { startedAt: 4, wasRunning: true })
    // Still the same turn: the start does not chase the growing transcript.
    const later = trackTicketTurn(working, { working: true, transcriptLength: 9 })
    assert.equal(later.startedAt, 4)
    // Between turns the finished turn is still the last completed one.
    const done = trackTicketTurn(later, { working: false, transcriptLength: 12 })
    assert.deepEqual(done, { startedAt: 4, wasRunning: false })
    // The next turn re-pins.
    const next = trackTicketTurn(done, { working: true, transcriptLength: 12 })
    assert.equal(next.startedAt, 12)
  })
})

describe('ticketActivityDigest', () => {
  it('changes with contents or liveness, not with report order', () => {
    assert.equal(ticketActivityDigest(true, ['a.md']), ticketActivityDigest(true, ['a.md']))
    assert.notEqual(ticketActivityDigest(true, ['a.md']), ticketActivityDigest(false, ['a.md']))
    assert.notEqual(ticketActivityDigest(true, ['a.md']), ticketActivityDigest(true, ['a.md', 'b.md']))
  })
})

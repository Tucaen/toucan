import { strict as assert } from 'node:assert'
import { describe, test } from 'vitest'
import {
  activityBodyStale,
  applyServerFrame,
  connectionLost,
  historyAvailable,
  historyFailed,
  initialChatConnectionState,
  plannedActivityBody,
  plannedHistory,
  readReportKey,
  visibleTranscript,
  withActivityBody,
  withHistoryRequest,
  type ChatConnectionState
} from '../mobile/src/chat-connection'
import { deriveChatViewItems } from '../mobile/src/chat-view'
import type { AgentEvent } from '../src/shared/agent'
import {
  agentTranscriptEntryKey,
  foldAgentEvent,
  initialAgentTranscriptState,
  type AgentTranscriptState
} from '../src/shared/agent-transcript'
import { REMOTE_CHAT_PAGE_ENTRIES, transcriptPage, transcriptWindow } from '../src/shared/remote-transcript-page'

/**
 * A long chat on the phone (#54): the window a snapshot carries, the older pages the reader loads,
 * and how the two survive a resync. Frames are cut by the same shared functions the host uses, and
 * convergence is asserted against the view derived from the host's whole transcript.
 */

const NOW = 1_700_000_000_000
const PAGE = REMOTE_CHAT_PAGE_ENTRIES

function fold(events: readonly AgentEvent[], from = initialAgentTranscriptState()): AgentTranscriptState {
  return events.reduce((state, event) => foldAgentEvent(state, event, NOW), from)
}

function conversation(count: number, prefix = ''): AgentEvent[] {
  return Array.from({ length: count }, (_, index): AgentEvent =>
    index % 2 === 0
      ? { type: 'message', role: 'user', messageId: `${prefix}u${index}`, text: `prompt ${index}` }
      : { type: 'activity', activity: { id: `${prefix}call-${index}`, title: `Read ${index}`, status: 'completed' } }
  )
}

function snapshotFrame(host: AgentTranscriptState): string {
  const window = transcriptWindow(host)
  return JSON.stringify({ type: 'snapshot', state: window.state, start: window.start })
}

function joined(host: AgentTranscriptState): ChatConnectionState {
  return applyServerFrame(initialChatConnectionState(), snapshotFrame(host), NOW)
}

/** Asks for the next page the way the hook does, and answers it the way the host would. */
function loadPage(state: ChatConnectionState, host: AgentTranscriptState, requestId = 'h'): ChatConnectionState {
  const planned = plannedHistory(state, requestId)
  assert.ok(planned, 'a page is plannable')
  const asked = withHistoryRequest(state, planned)
  const page = transcriptPage(host, planned.before)
  return applyServerFrame(asked, JSON.stringify({ type: 'history_result', requestId, ok: true, page }), NOW)
}

describe('loading older pages', () => {
  test('a window that starts at the beginning has nothing older to load', () => {
    const state = joined(fold(conversation(PAGE)))
    assert.equal(state.windowStart, 0)
    assert.equal(historyAvailable(state), false)
    assert.equal(plannedHistory(state, 'h'), null)
  })

  test('loading every page converges on exactly what the whole transcript renders', () => {
    const host = fold(conversation(PAGE * 4 + 7))
    let state = joined(host)
    assert.equal(state.windowStart, PAGE * 3)
    assert.equal(historyAvailable(state), true)

    let pages = 0
    while (historyAvailable(state)) {
      state = loadPage(state, host, `h${pages}`)
      pages += 1
    }
    assert.equal(pages, 3)
    assert.equal(state.history?.start, 0)
    assert.deepEqual(deriveChatViewItems(visibleTranscript(state)!), deriveChatViewItems(host))
  })

  test('a page is asked for before the oldest entry held, and only one at a time', () => {
    const host = fold(conversation(PAGE * 3))
    const state = joined(host)
    const planned = plannedHistory(state, 'h1')
    assert.equal(planned?.before, agentTranscriptEntryKey(host.transcript[PAGE * 2]!))
    const asked = withHistoryRequest(state, planned!)
    assert.equal(plannedHistory(asked, 'h2'), null)

    const loaded = loadPage(state, host)
    assert.equal(plannedHistory(loaded, 'h3')?.before, agentTranscriptEntryKey(host.transcript[PAGE]!))
  })

  test('a refusal is reported and retryable; a reply for another request is ignored', () => {
    const state = joined(fold(conversation(PAGE * 2)))
    const asked = withHistoryRequest(state, plannedHistory(state, 'h1')!)
    const stray = applyServerFrame(
      asked,
      JSON.stringify({ type: 'history_result', requestId: 'other', ok: false, message: 'no' }),
      NOW
    )
    assert.equal(stray, asked)

    const refused = applyServerFrame(
      asked,
      JSON.stringify({ type: 'history_result', requestId: 'h1', ok: false, message: 'That part is gone.' }),
      NOW
    )
    assert.deepEqual(refused.historyRequest, { status: 'failed', message: 'That part is gone.' })
    assert.ok(plannedHistory(refused, 'h2'), 'a failed request does not block a retry')
    assert.equal(historyFailed(state, 'x'), state, 'nothing in flight, nothing to fail')
  })

  test('a drop forgets a page in flight rather than reporting it', () => {
    const state = joined(fold(conversation(PAGE * 2)))
    const lost = connectionLost(withHistoryRequest(state, plannedHistory(state, 'h1')!))
    assert.deepEqual(lost.historyRequest, { status: 'idle' })
    assert.equal(plannedHistory(lost, 'h2'), null, 'not until the rejoin lands')
  })

  test('a call in a loaded page can be opened, and the tail keeps finishing it in place', () => {
    const host = fold([
      { type: 'activity', activity: { id: 'task', title: 'Task', status: 'in_progress' } },
      ...conversation(PAGE * 2 + 1)
    ])
    let state = loadPage(joined(host), host)
    assert.equal(state.history?.start, 0)
    assert.ok(plannedActivityBody(state, 'r1', 'task'), 'a call held only by a page is openable')
    state = withActivityBody(state, plannedActivityBody(state, 'r1', 'task')!)
    state = applyServerFrame(
      state,
      JSON.stringify({ type: 'activity_result', requestId: 'r1', ok: true, activity: host.activities.task }),
      NOW
    )

    const finished: AgentEvent = { type: 'activity', activity: { id: 'task', status: 'completed' } }
    state = applyServerFrame(state, JSON.stringify({ type: 'event', event: finished }), NOW)
    const visible = visibleTranscript(state)!
    // Still one card, still first, and finished.
    assert.equal(visible.transcript.filter((entry) => entry.id === 'task').length, 1)
    assert.equal(visible.transcript[0]?.id, 'task')
    assert.equal(visible.activities.task?.status, 'completed')
    assert.equal(activityBodyStale(state, 'task'), true)
    assert.deepEqual(deriveChatViewItems(visible), deriveChatViewItems(fold([finished], host)))
  })
})

describe('pages and the full resync', () => {
  test('a rejoin whose window has not moved keeps the loaded pages', () => {
    const host = fold(conversation(PAGE * 3))
    const loaded = loadPage(joined(host), host)
    const growing = fold(conversation(10, 'late-'), host)
    const rejoined = applyServerFrame(connectionLost(loaded), snapshotFrame(growing), NOW)
    assert.equal(rejoined.windowStart, loaded.windowStart)
    assert.equal(rejoined.history, loaded.history)
    assert.deepEqual(
      deriveChatViewItems(visibleTranscript(rejoined)!).slice(PAGE),
      deriveChatViewItems(growing).slice(PAGE * 2)
    )
  })

  test('a rejoin whose window moved on drops them: the window is the whole truth again', () => {
    const host = fold(conversation(PAGE * 3))
    const loaded = loadPage(joined(host), host)
    const moved = fold(conversation(PAGE, 'late-'), host)
    const rejoined = applyServerFrame(connectionLost(loaded), snapshotFrame(moved), NOW)
    assert.equal(rejoined.windowStart, PAGE * 3)
    assert.equal(rejoined.history, null)
    assert.equal(visibleTranscript(rejoined), rejoined.transcript)
    // And the reader can page back from there to the very same convergence.
    let state = rejoined
    while (historyAvailable(state)) state = loadPage(state, moved)
    assert.deepEqual(deriveChatViewItems(visibleTranscript(state)!), deriveChatViewItems(moved))
  })

  test('a different transcript at the same position drops them too', () => {
    const host = fold(conversation(PAGE * 3))
    const loaded = loadPage(joined(host), host)
    const other = fold(conversation(PAGE * 3, 'other-'))
    assert.equal(applyServerFrame(loaded, snapshotFrame(other), NOW).history, null)
  })

  test('a page that arrives after the window moved is not joined, and the loader may ask again', () => {
    const host = fold(conversation(PAGE * 3))
    const state = joined(host)
    const planned = plannedHistory(state, 'h1')!
    const moved = fold(conversation(PAGE, 'late-'), host)
    const resynced = applyServerFrame(withHistoryRequest(state, planned), snapshotFrame(moved), NOW)
    const late = applyServerFrame(
      resynced,
      JSON.stringify({ type: 'history_result', requestId: 'h1', ok: true, page: transcriptPage(host, planned.before) }),
      NOW
    )
    assert.equal(late.history, null)
    assert.deepEqual(late.historyRequest, { status: 'idle' })
    assert.ok(plannedHistory(late, 'h2'))
  })

  test('a whole turn that ran during a drop still reads as something new', () => {
    // The rejoin's window is the same length as the last one, further on: counted from the
    // beginning of the chat, the read key still moves.
    const ready: AgentEvent = { type: 'status', status: 'ready' }
    const host = fold([...conversation(PAGE * 2), ready])
    const later = fold([...conversation(PAGE, 'late-'), ready], host)
    assert.equal(transcriptWindow(later).state.transcript.length, transcriptWindow(host).state.transcript.length)
    const before = readReportKey(joined(host))
    const after = readReportKey(joined(later))
    assert.match(before ?? '', /^settled:/)
    assert.notEqual(before, after)
  })
})

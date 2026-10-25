import { strict as assert } from 'node:assert'
import { describe, test } from 'vitest'
import type { AgentEvent } from '../src/shared/agent'
import {
  agentTranscriptEntryKey,
  foldAgentEvent,
  initialAgentTranscriptState,
  type AgentTranscriptState
} from '../src/shared/agent-transcript'
import {
  REMOTE_CHAT_PAGE_ENTRIES,
  transcriptPage,
  transcriptWindow,
  transcriptWindowStart
} from '../src/shared/remote-transcript-page'

/**
 * What part of a transcript a phone is sent on join, and what one older page carries. Both are cut
 * from the broker's whole transcript by entry order, so the assertions are about which entries a
 * cut holds and that every entry it holds still resolves to its message, call or outcome.
 */

const NOW = 1_700_000_000_000
const PAGE = REMOTE_CHAT_PAGE_ENTRIES

function fold(events: AgentEvent[]): AgentTranscriptState {
  return events.reduce((state, event) => foldAgentEvent(state, event, NOW), initialAgentTranscriptState())
}

/** `count` entries alternating a user prompt and a completed tool call, in that order. */
function conversation(count: number): AgentEvent[] {
  const events: AgentEvent[] = []
  for (let index = 0; index < count; index += 1) {
    events.push(
      index % 2 === 0
        ? { type: 'message', role: 'user', messageId: `u${index}`, text: `prompt ${index}` }
        : { type: 'activity', activity: { id: `call-${index}`, title: `Read ${index}`, status: 'completed' } }
    )
  }
  return events
}

function keys(state: { transcript: AgentTranscriptState['transcript'] }): string[] {
  return state.transcript.map(agentTranscriptEntryKey)
}

describe('the join window', () => {
  test('starts on a page boundary and always holds at least a page', () => {
    assert.equal(transcriptWindowStart(0), 0)
    assert.equal(transcriptWindowStart(PAGE * 2 - 1), 0)
    assert.equal(transcriptWindowStart(PAGE * 2), PAGE)
    assert.equal(transcriptWindowStart(PAGE * 3 - 1), PAGE)
    assert.equal(transcriptWindowStart(PAGE * 3), PAGE * 2)
  })

  test('a short conversation is sent whole and untouched', () => {
    const state = fold(conversation(PAGE))
    const window = transcriptWindow(state)
    assert.equal(window.start, 0)
    assert.equal(window.state, state)
  })

  test('a long one keeps only its most recent entries, each still resolvable', () => {
    const state = fold(conversation(PAGE * 3 + 10))
    const window = transcriptWindow(state)
    assert.equal(window.start, PAGE * 2)
    assert.deepEqual(keys(window.state), keys(state).slice(PAGE * 2))
    for (const entry of window.state.transcript) {
      if (entry.type === 'activity') assert.ok(window.state.activities[entry.id])
      if (entry.type === 'message') assert.ok(window.state.messages.some((message) => message.id === entry.id))
    }
    assert.equal(window.state.messages.length, (PAGE + 10) / 2)
    assert.equal(Object.keys(window.state.activities).length, (PAGE + 10) / 2)
  })

  test('the session-level state rides along whole', () => {
    const state = fold([
      ...conversation(PAGE * 2),
      { type: 'status', status: 'working' },
      { type: 'plan', entries: [{ content: 'step', status: 'pending', priority: 'medium' }] }
    ])
    const window = transcriptWindow(state)
    assert.equal(window.state.status, 'working')
    assert.deepEqual(window.state.plan, state.plan)
  })

  test('a call still running is carried even when its entry is older than the window', () => {
    // A subagent's wrapping call opens, its children fill more than a window, and only then does it
    // finish. The finishing patch has to fold onto the call the phone already holds, not open a
    // second card for it at the end.
    const state = fold([
      { type: 'activity', activity: { id: 'task', title: 'Task', status: 'in_progress' } },
      { type: 'activity', activity: { id: 'done-early', title: 'Read', status: 'completed' } },
      ...conversation(PAGE * 2)
    ])
    const window = transcriptWindow(state)
    assert.ok(window.start > 1)
    assert.ok(window.state.activities.task, 'the open call is carried')
    assert.equal(window.state.activities['done-early'], undefined, 'a finished one is not')
    assert.equal(keys(window.state).includes('activity:task'), false, 'but it takes no slot in the window')

    const patched = foldAgentEvent(
      window.state,
      { type: 'activity', activity: { id: 'task', status: 'completed' } },
      NOW
    )
    assert.equal(patched.transcript.length, window.state.transcript.length)
    assert.equal(patched.activities.task?.status, 'completed')
  })

  test('an assistant message still streaming is carried the same way, so the turn end settles it', () => {
    const state = fold([
      { type: 'message', role: 'assistant', messageId: 'early', text: 'working on it' },
      ...Array.from({ length: PAGE * 2 }, (_, index): AgentEvent => ({
        type: 'activity',
        activity: { id: `call-${index}`, title: 'Read', status: 'completed' }
      }))
    ])
    const window = transcriptWindow(state)
    assert.ok(window.start > 0)
    assert.equal(window.state.messages.find((message) => message.id === 'early')?.complete, false)
  })

  test('an outcome is carried only with its entry', () => {
    const state = fold([
      { type: 'turn_failed', turnId: 'old', message: 'boom' },
      ...conversation(PAGE * 2),
      { type: 'turn_cancelled', turnId: 'new', message: 'stopped' }
    ])
    const window = transcriptWindow(state)
    assert.deepEqual(
      window.state.outcomes.map((outcome) => outcome.id),
      ['new']
    )
  })
})

describe('an older page', () => {
  test('is the page of entries right before the anchor, with what they reference', () => {
    const state = fold(conversation(PAGE * 3))
    const window = transcriptWindow(state)
    const anchor = agentTranscriptEntryKey(window.state.transcript[0]!)
    const page = transcriptPage(state, anchor)
    assert.ok(page)
    assert.equal(page.start, window.start - PAGE)
    assert.deepEqual(keys({ transcript: page.entries }), keys(state).slice(page.start, window.start))
    assert.equal(page.messages.length, PAGE / 2)
    assert.equal(Object.keys(page.activities).length, PAGE / 2)
  })

  test('stops at the beginning of the conversation', () => {
    const state = fold(conversation(PAGE * 2))
    const page = transcriptPage(state, agentTranscriptEntryKey(state.transcript[30]!))
    assert.ok(page)
    assert.equal(page.start, 0)
    assert.equal(page.entries.length, 30)
  })

  test('an anchor the transcript does not hold is no page at all', () => {
    assert.equal(transcriptPage(fold(conversation(10)), 'message:user:never'), null)
  })
})

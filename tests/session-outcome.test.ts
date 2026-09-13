import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import type { AgentEvent } from '../src/shared/agent'
import { foldAgentEvent, initialAgentTranscriptState, type AgentTranscriptState } from '../src/shared/agent-transcript'
import {
  SESSION_OUTCOME_EXCERPT_LIMIT,
  extractSessionOutcome,
  parseSessionOutcome,
  renderSessionOutcome,
  sessionOutcomeExcerpt,
  sessionOutcomeKey,
  type SessionOutcomeSource
} from '../src/shared/session-outcome'

const NOW = 1_700_000_000_000
const AT = '2026-09-13T10:00:00.000Z'

const SOURCE: SessionOutcomeSource = {
  provider: 'codex',
  conversationId: '019a2f3c-0001',
  projectPath: 'D:\\Development\\ADE'
}

function transcript(...events: AgentEvent[]): AgentTranscriptState {
  return events.reduce((state, event) => foldAgentEvent(state, event, NOW), initialAgentTranscriptState())
}

function user(messageId: string, text: string): AgentEvent {
  return { type: 'message', role: 'user', messageId, text }
}

function assistant(messageId: string, text: string, presentation?: 'progress' | 'final'): AgentEvent {
  return { type: 'message', role: 'assistant', messageId, text, ...(presentation ? { presentation } : {}) }
}

test('extracts the task from the first user message and the result from the latest final answer', () => {
  const snapshot = transcript(
    user('u1', 'Fan agent events out through a main-process broker so remote clients can subscribe.'),
    assistant('a1', 'Reading the session manager.', 'progress'),
    assistant('a2', 'Added the broker and wired the manager to it.', 'final'),
    { type: 'turn_complete', stopReason: 'end_turn' },
    user('u2', 'Now cover it with tests.'),
    assistant('a3', 'Added tests/agent-event-broker.test.ts.', 'final'),
    { type: 'turn_complete', stopReason: 'end_turn' }
  )

  const record = extractSessionOutcome(snapshot, SOURCE, null, AT)

  assert.ok(record)
  assert.equal(record.key, 'codex-019a2f3c-0001')
  assert.equal(record.provider, 'codex')
  assert.equal(record.conversationId, '019a2f3c-0001')
  assert.equal(record.projectPath, 'D:\\Development\\ADE')
  assert.equal(record.task, 'Fan agent events out through a main-process broker so remote clients can subscribe.')
  assert.equal(record.lastResult, 'Added tests/agent-event-broker.test.ts.')
  assert.equal(record.turns, 2)
  assert.equal(record.startedAt, AT)
  assert.equal(record.updatedAt, AT)
})

test('falls back to the latest progress message when a turn ended without a final answer', () => {
  const snapshot = transcript(
    user('u1', 'Rewrite the workspace store so a crash cannot tear the snapshot.'),
    assistant('a1', 'Promoting the primary to the backup first.', 'progress'),
    { type: 'turn_cancelled', turnId: 't1', message: 'Stopped by you.' }
  )

  const record = extractSessionOutcome(snapshot, SOURCE, null, AT)

  assert.equal(record?.lastResult, 'Promoting the primary to the backup first.')
})

test('records nothing for a conversation that has not been asked anything', () => {
  const snapshot = transcript({ type: 'status', status: 'working' }, assistant('a1', 'Ready.', 'final'))

  assert.equal(extractSessionOutcome(snapshot, SOURCE, null, AT), null)
})

test('caps both excerpts and keeps a record well under 2 KB', () => {
  const snapshot = transcript(
    user('u1', `Do this: ${'context '.repeat(400)}`),
    assistant('a1', `Done: ${'detail '.repeat(400)}`, 'final'),
    { type: 'turn_complete', stopReason: 'end_turn' }
  )

  const record = extractSessionOutcome(snapshot, SOURCE, null, AT)

  assert.ok(record)
  assert.ok(record.task.length <= SESSION_OUTCOME_EXCERPT_LIMIT)
  assert.ok(record.lastResult.length <= SESSION_OUTCOME_EXCERPT_LIMIT)
  assert.ok(record.task.endsWith('…'))
  assert.ok(renderSessionOutcome(record).length < 2048)
})

test('collapses newlines so an excerpt stays one line of prose', () => {
  const snapshot = transcript(
    user('u1', 'Line one\n\nLine two\n  - a bullet'),
    assistant('a1', 'Result\nacross\nlines', 'final'),
    { type: 'turn_complete', stopReason: 'end_turn' }
  )

  const record = extractSessionOutcome(snapshot, SOURCE, null, AT)

  assert.equal(record?.task, 'Line one Line two - a bullet')
  assert.equal(record?.lastResult, 'Result across lines')
})

test('re-derives every field each turn but carries the original start time forward', () => {
  const first = extractSessionOutcome(
    transcript(
      user('u1', 'Give the canvas a diff node for reviewing a worktree.'),
      assistant('a1', 'Added DiffNode.tsx.', 'final'),
      { type: 'turn_complete', stopReason: 'end_turn' }
    ),
    SOURCE,
    null,
    AT
  )
  assert.ok(first)

  const later = extractSessionOutcome(
    transcript(
      user('u1', 'Give the canvas a diff node for reviewing a worktree.'),
      assistant('a1', 'Added DiffNode.tsx.', 'final'),
      { type: 'turn_complete', stopReason: 'end_turn' },
      user('u2', 'Poll it only while the node is on screen.'),
      assistant('a2', 'Gated the refresh on visibility.', 'final'),
      { type: 'turn_complete', stopReason: 'end_turn' }
    ),
    SOURCE,
    first,
    '2026-09-13T11:30:00.000Z'
  )

  assert.equal(later?.startedAt, AT)
  assert.equal(later?.updatedAt, '2026-09-13T11:30:00.000Z')
  assert.equal(later?.turns, 2)
  assert.equal(later?.lastResult, 'Gated the refresh on visibility.')
})

test('carries the worktree only where the node is attached to one', () => {
  const snapshot = transcript(
    user('u1', 'Rebase the worktree branch onto main and resolve the conflicts.'),
    assistant('a1', 'Rebased cleanly.', 'final'),
    { type: 'turn_complete', stopReason: 'end_turn' }
  )

  assert.equal(extractSessionOutcome(snapshot, SOURCE, null, AT)?.worktreeId, undefined)
  assert.equal(extractSessionOutcome(snapshot, { ...SOURCE, worktreeId: 'wt-7' }, null, AT)?.worktreeId, 'wt-7')
})

test('a rendered record round-trips through the reader', () => {
  const snapshot = transcript(
    user('u1', 'Persist the session outcome index under userData as one file per conversation.'),
    assistant('a1', 'Wrote the store and the indexer.', 'final'),
    { type: 'turn_complete', stopReason: 'end_turn' }
  )
  const record = extractSessionOutcome(snapshot, { ...SOURCE, worktreeId: 'wt-2' }, null, AT)
  assert.ok(record)

  assert.deepEqual(parseSessionOutcome(renderSessionOutcome(record)), record)
})

test('a record whose frontmatter is unreadable is discarded rather than half-read', () => {
  assert.equal(parseSessionOutcome('no frontmatter here'), null)
  assert.equal(parseSessionOutcome('---\nprovider: gemini\nconversation: x\nproject: "C:"\n---\n'), null)
  assert.equal(parseSessionOutcome('---\nprovider: codex\nconversation: x\nproject: "C:"\nturns: many\n---\n'), null)
})

test('a conversation id that is not filename-safe cannot escape the outcomes directory', () => {
  assert.equal(sessionOutcomeKey('claude', '../../etc/passwd'), 'claude--etc-passwd')
  assert.equal(sessionOutcomeKey('claude', 'a b/c\\d'), 'claude-a-b-c-d')
})

test('an excerpt shorter than the cap is left exactly as written', () => {
  assert.equal(sessionOutcomeExcerpt('  Already   short  '), 'Already short')
})

test('the cap counts the ellipsis, including where there is no word boundary to break on', () => {
  // Unbroken text takes the branch that cannot fall back to a space; the ellipsis still has to
  // come out of the budget rather than be added past it.
  assert.equal(sessionOutcomeExcerpt('a'.repeat(900)).length, SESSION_OUTCOME_EXCERPT_LIMIT)
  assert.equal(sessionOutcomeExcerpt('word '.repeat(400)).length <= SESSION_OUTCOME_EXCERPT_LIMIT, true)
  assert.equal(sessionOutcomeExcerpt('ab'.repeat(50), 10), 'ababababa…')
})

test('reasoning is never mistaken for the agent having answered', () => {
  // `thought` messages carry no presentation, so relabelling one as assistant would pass the
  // `isFinalAssistantMessage` gate and title the conversation off its own reasoning.
  const snapshot = transcript(user('u1', 'Investigate why the workspace snapshot fails to load on startup.'), {
    type: 'message',
    role: 'thought',
    messageId: 't1',
    text: 'The backup promotion probably ran before the fsync.'
  })

  const record = extractSessionOutcome(snapshot, SOURCE, null, AT)

  assert.ok(record)
  assert.equal(record.lastResult, '')
  // No answer yet, so the title falls back to the task rather than to the thought.
  assert.equal(record.title, 'Investigate why the workspace snapshot fails to load on startup.')
})

test('the durable title outranks anything derived from the transcript', () => {
  const snapshot = transcript(
    user('u1', 'Give the canvas a diff node for reviewing a worktree.'),
    assistant('a1', 'Added DiffNode.tsx.', 'final'),
    { type: 'turn_complete', stopReason: 'end_turn' }
  )

  assert.equal(
    extractSessionOutcome(snapshot, { ...SOURCE, title: 'Worktree review' }, null, AT)?.title,
    'Worktree review'
  )
  assert.equal(
    extractSessionOutcome(snapshot, SOURCE, null, AT)?.title,
    'Give the canvas a diff node for reviewing a worktree'
  )
})

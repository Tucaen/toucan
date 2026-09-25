import { strict as assert } from 'node:assert'
import { test } from 'vitest'
import type { AgentEvent } from '../src/shared/agent'
import { foldAgentEvent, initialAgentTranscriptState, type AgentTranscriptState } from '../src/shared/agent-transcript'
import {
  SESSION_OUTCOME_ASK_LIMIT,
  SESSION_OUTCOME_ASKS_BUDGET,
  SESSION_OUTCOME_EXCERPT_LIMIT,
  SESSION_OUTCOME_FAILURE_LIMIT,
  SESSION_OUTCOME_FAILURE_MESSAGE_LIMIT,
  SESSION_OUTCOME_FILES_LIMIT,
  SESSION_OUTCOME_PATH_LIMIT,
  SESSION_OUTCOME_SIZE_BUDGET,
  SESSION_OUTCOME_TRIVIAL_TURNS,
  answeredLatestAsk,
  endedSessionOutcome,
  extractSessionOutcome,
  isTrivialSessionOutcome,
  parseSessionOutcome,
  prunableSessionOutcomes,
  renderSessionOutcome,
  sessionOutcomeAsksOmittedMarker,
  sessionOutcomeExcerpt,
  sessionOutcomeFileName,
  sessionOutcomeFilesOmittedMarker,
  sessionOutcomeKey,
  sessionOutcomeProjectGlob,
  sessionOutcomeShortIdSuffix,
  sessionOutcomeSlug,
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

test('the KVP-8801 handoff keeps every ask, the substantial result and the last word', () => {
  const snapshot = transcript(
    user('u1', '/implement CICKVP-8801'),
    assistant('a1', 'Implementing the offer form dates.', 'progress'),
    assistant(
      'a2',
      [
        '## TL;DR',
        '✅ CICKVP-8801 done',
        '',
        'The date flow now uses the requested business-day rule.',
        '',
        '```ts',
        'const implementationDetail = true',
        '```',
        '',
        '## Files',
        '- src/offer-form.ts'
      ].join('\n'),
      'final'
    ),
    { type: 'turn_complete', stopReason: 'end_turn' },
    user('u2', 'Explain why the weekend case changed.'),
    assistant('a3', 'Saturday and Sunday now advance to Monday, matching the acceptance example.', 'final'),
    { type: 'turn_complete', stopReason: 'end_turn' },
    user('u3', 'keep it'),
    assistant('a4', 'Done. I left the code as it is; no open points left.', 'final'),
    { type: 'turn_complete', stopReason: 'end_turn' }
  )

  const record = extractSessionOutcome(snapshot, SOURCE, null, AT)

  assert.ok(record)
  assert.equal(record.key, 'codex-019a2f3c-0001')
  assert.equal(record.provider, 'codex')
  assert.equal(record.conversationId, '019a2f3c-0001')
  assert.equal(record.projectPath, 'D:\\Development\\ADE')
  assert.equal(record.task, '/implement CICKVP-8801')
  assert.deepEqual(record.asks, [
    '/implement CICKVP-8801',
    'Explain why the weekend case changed.',
    'keep it'
  ])
  assert.equal(record.asksOmitted, 0)
  assert.equal(
    record.mainResult,
    [
      '### TL;DR',
      '✅ CICKVP-8801 done',
      '',
      'The date flow now uses the requested business-day rule.',
      '',
      '### Files',
      '- src/offer-form.ts'
    ].join('\n')
  )
  assert.equal(record.lastResult, 'Done. I left the code as it is; no open points left.')
  assert.equal(record.turns, 3)
  assert.equal(record.startedAt, AT)
  assert.equal(record.updatedAt, AT)
  const rendered = renderSessionOutcome(record)
  assert.match(rendered, /## Asks\n\n- \/implement CICKVP-8801/)
  assert.match(rendered, /## Main result\n\n### TL;DR/)
  assert.match(rendered, /## Last result\n\nDone\. I left the code as it is/)
  assert.ok(rendered.length <= SESSION_OUTCOME_SIZE_BUDGET)
  assert.deepEqual(parseSessionOutcome(rendered), record)
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

test('caps task and result excerpts while keeping the record within its budget', () => {
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

test('excerpts keep line breaks, collapse blank runs, drop fences and demote headings', () => {
  const snapshot = transcript(
    user('u1', 'Line one\n\n\nLine two\n```sh\necho hidden\n```\n## Files\n  - a bullet'),
    assistant('a1', 'Result\n\n\nacross\n## Files\nlines', 'final'),
    { type: 'turn_complete', stopReason: 'end_turn' }
  )

  const record = extractSessionOutcome(snapshot, SOURCE, null, AT)

  assert.equal(record?.task, 'Line one\n\nLine two\n### Files\n- a bullet')
  assert.equal(record?.lastResult, 'Result\n\nacross\n### Files\nlines')
  const rendered = renderSessionOutcome(record!)
  assert.equal((rendered.match(/^## Files$/gm) ?? []).length, 0)
  assert.deepEqual(parseSessionOutcome(rendered), record)
})

test('asks over budget keep the first and newest asks and round-trip their omission marker', () => {
  const snapshot = transcript(
    ...Array.from({ length: 9 }, (_, index) => user(`u${index}`, `Ask ${index}: ${'detail '.repeat(80)}`)),
    assistant('a1', 'Handled the latest ask.', 'final'),
    { type: 'turn_complete', stopReason: 'end_turn' }
  )

  const record = extractSessionOutcome(snapshot, SOURCE, null, AT)
  assert.ok(record)
  assert.equal(record.asks[0]?.startsWith('Ask 0:'), true)
  assert.equal(record.asks.at(-1)?.startsWith('Ask 8:'), true)
  assert.ok(record.asks.every((ask) => ask.length <= SESSION_OUTCOME_ASK_LIMIT))
  assert.ok(record.asks.reduce((total, ask) => total + ask.length, 0) <= SESSION_OUTCOME_ASKS_BUDGET)
  assert.ok(record.asksOmitted > 0)

  const rendered = renderSessionOutcome(record)
  assert.ok(rendered.includes(`- ${sessionOutcomeAsksOmittedMarker(record.asksOmitted)}`))
  assert.deepEqual(parseSessionOutcome(rendered), record)
})

test('a follow-up steered into a running turn counts as an ask of its own', () => {
  // `promptWhenIdle` publishes an accepted steer as a `user` message with no turn boundary of its
  // own, so one boundary can close over several asks. The hygiene filter planned for #191 skips a
  // conversation with fewer than two turns and reads this number: a session the captain steered
  // repeatedly is the opposite of trivial and must never be pruned as one.
  const snapshot = transcript(
    user('u1', 'Start the worktree handoff and report when the branch exists.'),
    assistant('a1', 'Creating the worktree.', 'progress'),
    user('u2', 'Also set the upstream while you are in there.'),
    user('u3', 'And leave the setup command alone.'),
    assistant('a2', 'Worktree created, upstream set, setup untouched.', 'final'),
    { type: 'turn_complete', stopReason: 'end_turn' }
  )

  const record = extractSessionOutcome(snapshot, SOURCE, null, AT)

  assert.equal(record?.turns, 3)
  // The task stays the conversation's opening ask, not the latest steer.
  assert.equal(record?.task, 'Start the worktree handoff and report when the branch exists.')
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
  // The filename's shortid is sanitised by the same rule, so no provider id reaches the directory
  // either way a record is addressed.
  assert.equal(sessionOutcomeShortIdSuffix('../../etc/passwd'), '---etc-pas')
})

test('a record is named by project, title and shortid, human-readably (#18)', () => {
  const record = {
    projectPath: 'D:\\Development\\cic.control-box',
    title: 'CICKVP-8801: Fix the offer form',
    conversationId: '69f89ec3-9536-41ce-851e-449d8366de18'
  }
  assert.equal(sessionOutcomeFileName(record), 'cic-control-box--cickvp-8801-fix-the-offer-form--69f89ec3')
  // A worktree session files under the main checkout it belongs to, not its worktree folder: that
  // is the name the reader will glob for.
  assert.equal(
    sessionOutcomeFileName({ ...record, projectPath: 'D:\\worktrees\\box-fix' }, 'D:\\Development\\cic.control-box'),
    'cic-control-box--cickvp-8801-fix-the-offer-form--69f89ec3'
  )
  // Lookup goes by the shortid suffix, the only part of the name a title change cannot move.
  assert.ok(sessionOutcomeFileName(record).endsWith(sessionOutcomeShortIdSuffix(record.conversationId)))
})

test('slugs keep Unicode letters, collapse everything else, and respect their caps (#18)', () => {
  assert.equal(sessionOutcomeSlug('Änderung übernehmen: Maß & Größe!', 48), 'änderung-übernehmen-maß-größe')
  assert.equal(sessionOutcomeSlug('  --Weird__punctuation--  ', 48), 'weird-punctuation')
  // The cap cuts and never leaves a dangling dash behind.
  assert.equal(sessionOutcomeSlug('one-two-three', 8), 'one-two')
  // A title of nothing but punctuation slugs to nothing rather than to dashes.
  assert.equal(sessionOutcomeSlug('!!!', 48), '')
})

test('the project glob is built by the same slug rule the filenames are written with (#18)', () => {
  assert.equal(sessionOutcomeProjectGlob('D:\\Development\\cic.control-box'), 'cic-control-box--*.md')
  // A sibling checkout sharing the prefix stays out: its slug continues where this glob demands
  // the double-dash separator.
  const name = sessionOutcomeFileName({
    projectPath: 'D:\\Development\\cic.control-box-legacy',
    title: 'Anything',
    conversationId: 'abc12345'
  })
  assert.ok(!new RegExp(`^${sessionOutcomeProjectGlob('D:\\Development\\cic.control-box').replace('*', '.*')}$`).test(`${name}.md`))
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

test('the write set accumulates across records rather than being re-derived', () => {
  const snapshot = transcript(
    user('u1', 'Give the outcome record the files each session wrote.'),
    assistant('a1', 'Accumulated at the tool-call seam.', 'final'),
    { type: 'turn_complete', stopReason: 'end_turn' }
  )
  const first = extractSessionOutcome(snapshot, { ...SOURCE, filesTouched: ['src/a.ts', 'src/b.ts'] }, null, AT)
  assert.ok(first)
  assert.deepEqual(first.filesTouched, ['src/a.ts', 'src/b.ts'])

  // A later process knows nothing about the first one's writes; the record is where they survived.
  const later = extractSessionOutcome(snapshot, { ...SOURCE, filesTouched: ['src/c.ts'] }, first, AT)

  assert.deepEqual(later?.filesTouched, ['src/a.ts', 'src/b.ts', 'src/c.ts'])
})

test('a file written again keeps one slot, at its most recent position', () => {
  const snapshot = transcript(
    user('u1', 'Rewrite the same file until it compiles.'),
    assistant('a1', 'Compiles now.', 'final'),
    { type: 'turn_complete', stopReason: 'end_turn' }
  )

  const record = extractSessionOutcome(
    snapshot,
    { ...SOURCE, filesTouched: ['src/a.ts', 'src/b.ts', 'src/a.ts'] },
    null,
    AT
  )

  assert.deepEqual(record?.filesTouched, ['src/b.ts', 'src/a.ts'])
})

test('the write set is capped at its own limit, keeping the most recent writes', () => {
  const snapshot = transcript(
    user('u1', 'Rename the symbol everywhere it appears.'),
    assistant('a1', 'Renamed across the tree.', 'final'),
    { type: 'turn_complete', stopReason: 'end_turn' }
  )
  const paths = Array.from({ length: 300 }, (_, index) => `src/file-${index}.ts`)

  const record = extractSessionOutcome(snapshot, { ...SOURCE, filesTouched: paths }, null, AT)

  assert.equal(record?.filesTouched.length, SESSION_OUTCOME_FILES_LIMIT)
  assert.equal(record?.filesTouched.at(-1), 'src/file-299.ts')
  assert.equal(record?.filesTouched.at(0), `src/file-${300 - SESSION_OUTCOME_FILES_LIMIT}.ts`)
})

test('failed and cancelled turns are recorded with their reason', () => {
  const snapshot = transcript(
    user('u1', 'Run the packaging build and report what breaks.'),
    { type: 'turn_cancelled', turnId: 't1', message: 'Stopped by you.' },
    user('u2', 'Try again.'),
    assistant('a2', 'It threw.', 'final'),
    { type: 'turn_failed', turnId: 't2', message: 'Adapter exited with code 1.' }
  )

  const record = extractSessionOutcome(snapshot, SOURCE, null, AT)

  assert.deepEqual(record?.failures, [
    { id: 't1', status: 'cancelled', message: 'Stopped by you.' },
    { id: 't2', status: 'failed', message: 'Adapter exited with code 1.' }
  ])
})

test('only the most recent failures are kept, with their messages capped', () => {
  const snapshot = transcript(
    user('u1', 'Keep retrying the flaky suite.'),
    ...Array.from({ length: SESSION_OUTCOME_FAILURE_LIMIT + 2 }, (_, index): AgentEvent => ({
      type: 'turn_failed',
      turnId: `t${index}`,
      message: `Attempt ${index} failed: ${'stack frame '.repeat(80)}`
    }))
  )

  const record = extractSessionOutcome(snapshot, SOURCE, null, AT)

  assert.equal(record?.failures.length, SESSION_OUTCOME_FAILURE_LIMIT)
  assert.equal(record?.failures.at(-1)?.id, `t${SESSION_OUTCOME_FAILURE_LIMIT + 1}`)
  assert.ok((record?.failures.at(-1)?.message.length ?? 0) <= SESSION_OUTCOME_FAILURE_MESSAGE_LIMIT)
  assert.ok(record?.failures.at(-1)?.message.endsWith('…'))
})

test('a conversation still taking turns is active, however its last turn ended', () => {
  const answered = transcript(
    user('u1', 'Land the first half now and the rest tomorrow.'),
    assistant('a1', 'First half landed.', 'final'),
    { type: 'turn_complete', stopReason: 'end_turn' }
  )
  const failed = transcript(user('u1', 'Land the first half now and the rest tomorrow.'), {
    type: 'turn_failed',
    turnId: 't1',
    message: 'Adapter exited.'
  })

  assert.equal(extractSessionOutcome(answered, SOURCE, null, AT)?.status, 'active')
  assert.equal(extractSessionOutcome(failed, SOURCE, null, AT)?.status, 'active')
})

function ended(snapshot: AgentTranscriptState, ending: 'complete' | 'failed' | 'cancelled'): string | undefined {
  const record = extractSessionOutcome(snapshot, SOURCE, null, AT)
  return record ? endedSessionOutcome(record, ending, answeredLatestAsk(snapshot), AT).status : undefined
}

test('a session that ended on a clean answered turn is completed', () => {
  const snapshot = transcript(
    user('u1', 'Finish the indexer and then I am closing the node.'),
    assistant('a1', 'Finished.', 'final'),
    { type: 'turn_complete', stopReason: 'end_turn' }
  )

  assert.equal(ended(snapshot, 'complete'), 'completed')
})

test('a session that ended on a failed, cancelled or unanswered turn is abandoned', () => {
  const answered = transcript(
    user('u1', 'Finish the indexer and then I am closing the node.'),
    assistant('a1', 'Finished.', 'final'),
    { type: 'turn_complete', stopReason: 'end_turn' }
  )
  // A turn that closed cleanly but left only narration behind answered nothing, so the
  // conversation is no more finished than one whose adapter fell over.
  const unanswered = transcript(
    user('u1', 'Finish the indexer and then I am closing the node.'),
    assistant('a1', 'Still reading the store.', 'progress'),
    { type: 'turn_complete', stopReason: 'end_turn' }
  )

  assert.equal(ended(answered, 'failed'), 'abandoned')
  assert.equal(ended(answered, 'cancelled'), 'abandoned')
  assert.equal(ended(unanswered, 'complete'), 'abandoned')
})

test('an answer to an earlier ask does not make the latest one answered', () => {
  // The conversation was answered once and then asked again; the last turn closed cleanly with
  // nothing to say. Reading the whole transcript for "did it answer" would report this finished.
  const snapshot = transcript(
    user('u1', 'Land the worktree handoff.'),
    assistant('a1', 'Landed.', 'final'),
    { type: 'turn_complete', stopReason: 'end_turn' },
    user('u2', 'Now do the same for the remote surface.'),
    { type: 'turn_complete', stopReason: 'end_turn' }
  )

  assert.equal(answeredLatestAsk(snapshot), false)
  assert.equal(ended(snapshot, 'complete'), 'abandoned')
  // The last result is still the only thing the agent ever reported, which beats reporting nothing.
  assert.equal(extractSessionOutcome(snapshot, SOURCE, null, AT)?.lastResult, 'Landed.')
})

test('finalizing settles the status and nothing else about the record', () => {
  const snapshot = transcript(
    user('u1', 'Write the record and then close the node.'),
    assistant('a1', 'Written.', 'final'),
    { type: 'turn_complete', stopReason: 'end_turn' }
  )
  const record = extractSessionOutcome(snapshot, { ...SOURCE, filesTouched: ['src/a.ts'] }, null, AT)
  assert.ok(record)

  const settled = endedSessionOutcome(record, 'complete', true, '2026-09-13T12:00:00.000Z')

  assert.deepEqual(settled, { ...record, status: 'completed', updatedAt: '2026-09-13T12:00:00.000Z' })
})

test('a record filled to every cap still fits the retrieval budget', () => {
  const snapshot = transcript(
    user('u1', `Do this: ${'context '.repeat(400)}`),
    ...Array.from({ length: SESSION_OUTCOME_FAILURE_LIMIT }, (_, index): AgentEvent => ({
      type: 'turn_failed',
      turnId: `turn-${'x'.repeat(30)}-${index}`,
      message: 'stack frame '.repeat(80)
    })),
    assistant('a1', `Done: ${'detail '.repeat(400)}`, 'final'),
    { type: 'turn_complete', stopReason: 'end_turn' }
  )
  const record = extractSessionOutcome(
    snapshot,
    {
      ...SOURCE,
      worktreeId: 'wt-11',
      codeState: { commit: 'f'.repeat(40), branch: `feature/${'long-branch-name-'.repeat(12)}` },
      filesTouched: Array.from({ length: 300 }, (_, index) => `src/${'deeply-nested/'.repeat(20)}file-${index}.ts`)
    },
    null,
    AT
  )
  assert.ok(record)

  assert.ok(record.filesTouched.every((path) => path.length <= SESSION_OUTCOME_PATH_LIMIT))
  // The marker is part of what a saturated record renders, so it is part of what the budget has to
  // hold: a fixture that stopped truncating would stop measuring the case this ceiling is for.
  assert.ok(renderSessionOutcome(record).includes(sessionOutcomeFilesOmittedMarker(record.filesOmitted)))
  assert.ok(renderSessionOutcome(record).length <= SESSION_OUTCOME_SIZE_BUDGET)
})

test('files, failures and status round-trip through the reader', () => {
  const snapshot = transcript(
    user('u1', 'Persist what each session wrote and how it ended.'),
    assistant('a1', 'Wrote the files and the failures into the record.', 'final'),
    { type: 'turn_cancelled', turnId: 't1', message: '' },
    { type: 'turn_failed', turnId: 't2', message: 'Adapter exited: ENOENT' },
    { type: 'turn_complete', stopReason: 'end_turn' }
  )
  const captured = extractSessionOutcome(
    snapshot,
    { ...SOURCE, filesTouched: ['src/shared/session-outcome.ts', 'tests/x.test.ts'] },
    null,
    AT
  )
  assert.ok(captured)
  const record = endedSessionOutcome(captured, 'complete', true, AT)
  assert.equal(record.status, 'completed')

  assert.deepEqual(parseSessionOutcome(renderSessionOutcome(record)), record)
})

test('the code state a turn was captured against round-trips, and each capture re-reads it (Tucaen/toucan#17)', () => {
  const snapshot = transcript(user('u1', 'Fix the flaky capture test.'), {
    type: 'turn_failed',
    turnId: 't1',
    message: 'Typecheck failed.'
  })
  const first = extractSessionOutcome(
    snapshot,
    { ...SOURCE, codeState: { commit: '93ff65b0c2f1d4e5a6b7c8d9e0f1a2b3c4d5e6f7', branch: 'feature/outcomes' } },
    null,
    AT
  )
  assert.ok(first)
  assert.match(renderSessionOutcome(first), /^commit: 93ff65b0c2f1d4e5a6b7c8d9e0f1a2b3c4d5e6f7$/m)
  assert.match(renderSessionOutcome(first), /^branch: feature\/outcomes$/m)
  assert.deepEqual(parseSessionOutcome(renderSessionOutcome(first)), first)

  // The latest boundary's HEAD is what the failures were last observed against, so a later capture
  // replaces the commit rather than keeping the first one - and a detached HEAD has no branch.
  const later = extractSessionOutcome(
    snapshot,
    { ...SOURCE, codeState: { commit: 'a622222222222222222222222222222222222222' } },
    first,
    AT
  )
  assert.ok(later)
  assert.equal(later.commit, 'a622222222222222222222222222222222222222')
  assert.equal(later.branch, undefined)
  assert.doesNotMatch(renderSessionOutcome(later), /^branch:/m)
  assert.deepEqual(parseSessionOutcome(renderSessionOutcome(later)), later)
})

test('a project that is not a git checkout carries no code state at all (Tucaen/toucan#17)', () => {
  const snapshot = transcript(user('u1', 'Tidy the notes folder.'))
  const record = extractSessionOutcome(snapshot, SOURCE, null, AT)
  assert.ok(record)

  assert.equal('commit' in record, false)
  assert.equal('branch' in record, false)
  assert.doesNotMatch(renderSessionOutcome(record), /^(commit|branch):/m)
})

test('a realistic record still fits the 2 KB the tracer bullet budgeted for', () => {
  // The worst case is bounded by SESSION_OUTCOME_SIZE_BUDGET; this is the case that decides whether
  // hundreds of records actually fit one context window, and the tracer bullet's claim about it
  // must survive files, failures and status being added.
  const snapshot = transcript(
    user('u1', 'Give the outcome record the files each session wrote, its failures and a status.'),
    assistant('a1', 'Accumulated the write set at the tool-call seam and finalized status at close.', 'final'),
    { type: 'turn_failed', turnId: 'turn-3', message: 'Typecheck failed: 2 errors in session-outcome.ts.' },
    { type: 'turn_complete', stopReason: 'end_turn' }
  )
  const record = extractSessionOutcome(
    snapshot,
    {
      ...SOURCE,
      filesTouched: Array.from(
        { length: SESSION_OUTCOME_FILES_LIMIT },
        (_, index) => `src/main/session-outcome-indexer-${index}.ts`
      )
    },
    null,
    AT
  )
  assert.ok(record)

  assert.equal(record.filesTouched.length, SESSION_OUTCOME_FILES_LIMIT)
  assert.ok(renderSessionOutcome(record).length < 2048)
})

test('a record that wrote nothing and failed nowhere spends no budget saying so', () => {
  const snapshot = transcript(
    user('u1', 'Explain how the wake gate decides to flush.'),
    assistant('a1', 'It flushes once the turn settles.', 'final'),
    { type: 'turn_complete', stopReason: 'end_turn' }
  )
  const record = extractSessionOutcome(snapshot, SOURCE, null, AT)
  assert.ok(record)

  const rendered = renderSessionOutcome(record)
  assert.ok(!rendered.includes('## Files'))
  assert.ok(!rendered.includes('## Failures'))
  assert.deepEqual(parseSessionOutcome(rendered), record)
})

test('an unreadable status never reads as a finished session', () => {
  const record = parseSessionOutcome(
    '---\nprovider: codex\nconversation: x\nproject: "C:"\nstatus: finito\nturns: 1\nstarted: a\nupdated: b\n---\n'
  )

  assert.equal(record?.status, 'active')
})

test('a one-ask conversation that wrote nothing is trivial, and either half of that undoes it', () => {
  assert.equal(isTrivialSessionOutcome({ turns: 1, filesTouched: [] }), true)
  // A second ask is work, whether or not it produced a file.
  assert.equal(isTrivialSessionOutcome({ turns: SESSION_OUTCOME_TRIVIAL_TURNS, filesTouched: [] }), false)
  // So is a write, however short the conversation that made it.
  assert.equal(isTrivialSessionOutcome({ turns: 1, filesTouched: ['src/main/index.ts'] }), false)
  // And a conversation nobody has asked anything yet is not a record worth keeping either.
  assert.equal(isTrivialSessionOutcome({ turns: 0, filesTouched: [] }), true)
})

test('an index under its cap prunes nothing', () => {
  const entries = Array.from({ length: 4 }, (_, index) => ({ name: `codex-${index}`, updatedAt: `2026-09-0${index}` }))

  assert.deepEqual(
    prunableSessionOutcomes(entries, () => false, 4),
    []
  )
})

test('pruning drops the least recently updated records first, and only as many as the cap needs', () => {
  const entries = [
    { name: 'codex-newest', updatedAt: '2026-09-13T10:00:00.000Z' },
    { name: 'codex-oldest', updatedAt: '2026-01-02T10:00:00.000Z' },
    { name: 'codex-middle', updatedAt: '2026-05-05T10:00:00.000Z' },
    { name: 'codex-second-oldest', updatedAt: '2026-02-02T10:00:00.000Z' }
  ]

  assert.deepEqual(
    prunableSessionOutcomes(entries, () => false, 2),
    ['codex-oldest', 'codex-second-oldest']
  )
})

test('a record whose timestamp could not be read is the first thing pruned', () => {
  // `keys()` names every file; a record the parser refused contributes no `updated`, and a file
  // that cannot be read back is worth less than any record that can.
  const entries = [
    { name: 'codex-good', updatedAt: '2026-01-01T10:00:00.000Z' },
    { name: 'codex-damaged', updatedAt: '' }
  ]

  assert.deepEqual(
    prunableSessionOutcomes(entries, () => false, 1),
    ['codex-damaged']
  )
})

test('pruning never takes the record of a session that is still running', () => {
  const entries = [
    { name: 'codex-live-and-old', updatedAt: '2026-01-01T10:00:00.000Z' },
    { name: 'codex-dormant', updatedAt: '2026-02-01T10:00:00.000Z' },
    { name: 'codex-newest', updatedAt: '2026-03-01T10:00:00.000Z' }
  ]

  const doomed = prunableSessionOutcomes(entries, (name) => name === 'codex-live-and-old', 2)

  // The oldest record is skipped for being live, so the cap is met by taking the next one instead.
  assert.deepEqual(doomed, ['codex-dormant'])
})

test('an index whose every record is live stays over its cap rather than pruning one', () => {
  const entries = [
    { name: 'codex-a', updatedAt: '2026-01-01T10:00:00.000Z' },
    { name: 'codex-b', updatedAt: '2026-02-01T10:00:00.000Z' }
  ]

  assert.deepEqual(
    prunableSessionOutcomes(entries, () => true, 1),
    []
  )
})

test('records updated within the same tick prune in a deterministic order', () => {
  const entries = [
    { name: 'codex-b', updatedAt: AT },
    { name: 'codex-a', updatedAt: AT },
    { name: 'codex-c', updatedAt: AT }
  ]

  assert.deepEqual(
    prunableSessionOutcomes(entries, () => false, 1),
    ['codex-a', 'codex-b']
  )
})

test('a truncated write set names how many files it dropped', () => {
  const snapshot = transcript(
    user('u1', 'Rename the symbol everywhere it appears.'),
    assistant('a1', 'Renamed across the tree.', 'final'),
    { type: 'turn_complete', stopReason: 'end_turn' }
  )
  const paths = Array.from({ length: 300 }, (_, index) => `src/file-${index}.ts`)

  const record = extractSessionOutcome(snapshot, { ...SOURCE, filesTouched: paths }, null, AT)
  assert.ok(record)

  assert.equal(record.filesOmitted, 300 - SESSION_OUTCOME_FILES_LIMIT)
  // The marker is the last line of the list, so what a reader sees under `## Files` ends by
  // saying the list is partial rather than trailing off as though it were whole.
  const files = renderSessionOutcome(record).split('## Files\n\n')[1]?.trimEnd().split('\n') ?? []
  assert.equal(files.length, SESSION_OUTCOME_FILES_LIMIT + 1)
  assert.equal(files.at(-1), `- … and at least ${300 - SESSION_OUTCOME_FILES_LIMIT} older files omitted`)
})

test('a write set at exactly the cap must not claim to be truncated', () => {
  const snapshot = transcript(user('u1', 'Touch exactly the cap.'), assistant('a1', 'Touched.', 'final'), {
    type: 'turn_complete',
    stopReason: 'end_turn'
  })
  const paths = Array.from({ length: SESSION_OUTCOME_FILES_LIMIT }, (_, index) => `src/file-${index}.ts`)

  const record = extractSessionOutcome(snapshot, { ...SOURCE, filesTouched: paths }, null, AT)
  assert.ok(record)

  assert.equal(record.filesOmitted, 0)
  assert.ok(!renderSessionOutcome(record).includes('omitted'))
})

test('a truncated record round-trips without reading its marker as a file', () => {
  const snapshot = transcript(
    user('u1', 'Rename the symbol everywhere it appears.'),
    assistant('a1', 'Renamed across the tree.', 'final'),
    { type: 'turn_complete', stopReason: 'end_turn' }
  )
  const paths = Array.from({ length: 40 }, (_, index) => `src/file-${index}.ts`)
  const record = extractSessionOutcome(snapshot, { ...SOURCE, filesTouched: paths }, null, AT)
  assert.ok(record)

  const read = parseSessionOutcome(renderSessionOutcome(record))

  assert.deepEqual(read, record)
  assert.equal(read?.filesTouched.length, SESSION_OUTCOME_FILES_LIMIT)
  assert.ok(read?.filesTouched.every((path) => path.startsWith('src/file-')))
})

test('the omitted count holds steady over a turn that wrote nothing new', () => {
  const snapshot = transcript(
    user('u1', 'Rename the symbol everywhere it appears.'),
    assistant('a1', 'Renamed across the tree.', 'final'),
    { type: 'turn_complete', stopReason: 'end_turn' }
  )
  const paths = Array.from({ length: 40 }, (_, index) => `src/file-${index}.ts`)
  const first = extractSessionOutcome(snapshot, { ...SOURCE, filesTouched: paths }, null, AT)
  assert.ok(first)
  assert.equal(first.filesOmitted, 40 - SESSION_OUTCOME_FILES_LIMIT)

  // The same session reporting the same write set at a later boundary: its own contribution is
  // already in the record, and counting it twice would make the marker grow turn after turn.
  const later = extractSessionOutcome(snapshot, { ...SOURCE, filesTouched: paths }, first, AT)

  assert.equal(later?.filesOmitted, 40 - SESSION_OUTCOME_FILES_LIMIT)
})

test('the omitted count is a floor a later process can only raise', () => {
  const snapshot = transcript(
    user('u1', 'Rename the symbol everywhere it appears.'),
    assistant('a1', 'Renamed across the tree.', 'final'),
    { type: 'turn_complete', stopReason: 'end_turn' }
  )
  const first = extractSessionOutcome(
    snapshot,
    { ...SOURCE, filesTouched: Array.from({ length: 40 }, (_, index) => `old/file-${index}.ts`) },
    null,
    AT
  )
  assert.ok(first)

  // A later process knows only the record, so it cannot tell whether its own writes are files the
  // first process already dropped. It carries what the record knew and stays a floor - never zero
  // where a list was truncated, which is the only claim the marker actually makes.
  const later = extractSessionOutcome(
    snapshot,
    { ...SOURCE, filesTouched: Array.from({ length: 10 }, (_, index) => `new/file-${index}.ts`) },
    first,
    AT
  )

  assert.equal(later?.filesTouched.length, SESSION_OUTCOME_FILES_LIMIT)
  assert.equal(later?.filesOmitted, 40 - SESSION_OUTCOME_FILES_LIMIT)
})

test('a list one file over the cap says so in the singular', () => {
  const snapshot = transcript(user('u1', 'Touch one file more than the cap.'), assistant('a1', 'Touched.', 'final'), {
    type: 'turn_complete',
    stopReason: 'end_turn'
  })
  const paths = Array.from({ length: SESSION_OUTCOME_FILES_LIMIT + 1 }, (_, index) => `src/file-${index}.ts`)

  const record = extractSessionOutcome(snapshot, { ...SOURCE, filesTouched: paths }, null, AT)
  assert.ok(record)

  assert.equal(record.filesOmitted, 1)
  assert.ok(renderSessionOutcome(record).includes('- … and at least 1 older file omitted'))
  assert.deepEqual(parseSessionOutcome(renderSessionOutcome(record)), record)
})

test('a count with no paths left to show is still reported', () => {
  const snapshot = transcript(
    user('u1', 'Write files this record cannot list.'),
    assistant('a1', 'Written.', 'final'),
    { type: 'turn_complete', stopReason: 'end_turn' }
  )
  const record = extractSessionOutcome(snapshot, SOURCE, null, AT)
  assert.ok(record)

  // Not reachable through extraction - the cap only bites once there are paths to keep - but the
  // renderer must not answer "nothing was written" to a record that says otherwise, which is the
  // very failure the marker exists to prevent.
  const truncated = { ...record, filesTouched: [], filesOmitted: 4 }

  assert.ok(renderSessionOutcome(truncated).includes('- … and at least 4 older files omitted'))
  assert.deepEqual(parseSessionOutcome(renderSessionOutcome(truncated)), truncated)
})

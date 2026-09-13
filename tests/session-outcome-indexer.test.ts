import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { AgentEvent } from '../src/shared/agent'
import { createAgentEventBroker } from '../src/main/agent-event-broker'
import { createSessionOutcomeIndexer, type SessionOutcomeContext } from '../src/main/session-outcome-indexer'
import { createSessionOutcomeStore } from '../src/main/session-outcome-store'
import {
  SESSION_OUTCOME_FILES_LIMIT,
  parseSessionOutcome,
  type SessionOutcomeRecord
} from '../src/shared/session-outcome'

const NOW = 1_700_000_000_000

function user(messageId: string, text: string): AgentEvent {
  return { type: 'message', role: 'user', messageId, text }
}

function assistant(messageId: string, text: string): AgentEvent {
  return { type: 'message', role: 'assistant', messageId, text, presentation: 'final' }
}

interface Fixture {
  publish(...events: AgentEvent[]): void
  /** Reports written files the way the session manager's tool-call seam does: absolute paths. */
  write(...paths: string[]): void
  /** A second watch on the same conversation - what resuming a dormant node looks like. */
  rewatch(): { write(...paths: string[]): void }
  /** Retires the session's channel the way `AcpSessionManager.stop` does. */
  close(): void
  /** A turn boundary is observed synchronously and written asynchronously; this awaits the write. */
  settle(): Promise<void>
  record(key: string): SessionOutcomeRecord | null
  damage(key: string): void
  files(): string[]
  dispose(): void
}

function fixture(context: Partial<SessionOutcomeContext> = {}, worktreeId?: string, title?: string): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'toucan-outcomes-'))
  const directory = join(root, 'session-outcomes')
  const broker = createAgentEventBroker({ now: () => NOW })
  let clock = Date.parse('2026-09-13T10:00:00.000Z')
  const failures: string[] = []
  const indexer = createSessionOutcomeIndexer({
    broker,
    store: createSessionOutcomeStore({ directory }),
    ...(worktreeId ? { worktreeIdForNode: async (): Promise<string> => worktreeId } : {}),
    ...(title ? { titleFor: async (): Promise<string> => title } : {}),
    now: () => new Date((clock += 60_000)),
    log: (message) => failures.push(message)
  })
  const watches = [
    indexer.watch('node-1', () => ({
      provider: 'codex',
      conversationId: 'conv-1',
      projectPath: 'D:\\Development\\ADE',
      ...context
    }))
  ]
  const pathFor = (key: string): string => join(directory, `${key}.md`)
  return {
    publish: (...events) => {
      for (const event of events) broker.publish('node-1', event)
    },
    write: (...paths) => watches[0].recordWrites(paths),
    rewatch: () => {
      const resumed = indexer.watch('node-1', () => ({
        provider: 'codex',
        conversationId: 'conv-1',
        projectPath: 'D:\\Development\\ADE',
        ...context
      }))
      watches.push(resumed)
      return { write: (...paths: string[]) => resumed.recordWrites(paths) }
    },
    close: () => broker.close('node-1'),
    settle: async () => {
      for (const watch of watches) await watch.idle()
      assert.deepEqual(failures, [])
    },
    record: (key) => parseSessionOutcome(readFileSync(pathFor(key), 'utf8')),
    damage: (key) => writeFileSync(pathFor(key), 'not a record at all', 'utf8'),
    // The directory is created by the first write, so "nothing recorded" is an absent directory.
    files: () => {
      try {
        return readdirSync(directory)
      } catch {
        return []
      }
    },
    dispose: () => rmSync(root, { recursive: true, force: true })
  }
}

test('a completed turn writes one record for the conversation', async () => {
  const session = fixture()
  try {
    session.publish(
      user('u1', 'Write the session outcome index tracer bullet.'),
      assistant('a1', 'Added the shared record, the store and the indexer.'),
      { type: 'turn_complete', stopReason: 'end_turn' }
    )
    await session.settle()

    assert.deepEqual(session.files(), ['codex-conv-1.md'])
    const record = session.record('codex-conv-1')
    assert.equal(record?.task, 'Write the session outcome index tracer bullet.')
    assert.equal(record?.lastResult, 'Added the shared record, the store and the indexer.')
    assert.equal(record?.turns, 1)
    assert.equal(record?.projectPath, 'D:\\Development\\ADE')
  } finally {
    session.dispose()
  }
})

test('completed, cancelled and failed turns all upsert the same record', async () => {
  const session = fixture()
  try {
    session.publish(
      user('u1', 'Write the session outcome index tracer bullet.'),
      assistant('a1', 'Added the shared record.'),
      { type: 'turn_complete', stopReason: 'end_turn' }
    )
    await session.settle()
    const first = session.record('codex-conv-1')

    session.publish(user('u2', 'Now cancel halfway and see what lands.'), assistant('a2', 'Stopped after the store.'), {
      type: 'turn_cancelled',
      turnId: 't2',
      message: 'Stopped by you.'
    })
    session.publish(user('u3', 'And make the third one fail.'), assistant('a3', 'It threw.'), {
      type: 'turn_failed',
      turnId: 't3',
      message: 'Adapter exited.'
    })
    await session.settle()

    assert.deepEqual(session.files(), ['codex-conv-1.md'])
    const latest = session.record('codex-conv-1')
    assert.equal(latest?.turns, 3)
    assert.equal(latest?.lastResult, 'It threw.')
    assert.equal(latest?.startedAt, first?.startedAt)
    assert.notEqual(latest?.updatedAt, first?.updatedAt)
  } finally {
    session.dispose()
  }
})

test('nothing is recorded before the provider has reported a conversation id', async () => {
  const session = fixture({ conversationId: null })
  try {
    session.publish(user('u1', 'Start something the provider has not named yet.'), assistant('a1', 'Working on it.'), {
      type: 'turn_complete',
      stopReason: 'end_turn'
    })
    await session.settle()

    assert.deepEqual(session.files(), [])
  } finally {
    session.dispose()
  }
})

test('the worktree a node is attached to reaches the record', async () => {
  const session = fixture({}, 'wt-5')
  try {
    session.publish(
      user('u1', 'Implement this in the worktree and report back.'),
      assistant('a1', 'Done on the branch.'),
      { type: 'turn_complete', stopReason: 'end_turn' }
    )
    await session.settle()

    assert.equal(session.record('codex-conv-1')?.worktreeId, 'wt-5')
  } finally {
    session.dispose()
  }
})

test('events that are not turn boundaries never touch the store', async () => {
  const session = fixture()
  try {
    session.publish(user('u1', 'Stream something without finishing the turn.'), assistant('a1', 'Halfway there.'), {
      type: 'status',
      status: 'working'
    })
    await session.settle()

    assert.deepEqual(session.files(), [])
  } finally {
    session.dispose()
  }
})

test('a record left unreadable on disk is rewritten from the transcript', async () => {
  const session = fixture()
  try {
    session.publish(user('u1', 'Write the record once so the file exists.'), assistant('a1', 'Written.'), {
      type: 'turn_complete',
      stopReason: 'end_turn'
    })
    await session.settle()
    session.damage('codex-conv-1')

    session.publish(user('u2', 'Write it again over the damaged file.'), assistant('a2', 'Rewritten.'), {
      type: 'turn_complete',
      stopReason: 'end_turn'
    })
    await session.settle()

    const record = session.record('codex-conv-1')
    assert.equal(record?.turns, 2)
    assert.equal(record?.lastResult, 'Rewritten.')
  } finally {
    session.dispose()
  }
})

test('the final turn still lands when the session is stopped before the write completes', async () => {
  const session = fixture()
  try {
    session.publish(user('u1', 'Finish this and then close the node immediately.'), assistant('a1', 'All done.'), {
      type: 'turn_complete',
      stopReason: 'end_turn'
    })
    // The write is still queued behind disk I/O here; stopping drops the broker's snapshot, so a
    // capture that read it lazily would find nothing and lose the last turn of the conversation.
    session.close()
    await session.settle()

    assert.deepEqual(session.files(), ['codex-conv-1.md'])
    assert.equal(session.record('codex-conv-1')?.lastResult, 'All done.')
  } finally {
    session.dispose()
  }
})

test('the durable title reaches the record ahead of the derived one', async () => {
  const session = fixture({}, undefined, 'Session outcome index')
  try {
    session.publish(
      user('u1', 'Write the session outcome index tracer bullet.'),
      assistant('a1', 'Added the shared record, the store and the indexer.'),
      { type: 'turn_complete', stopReason: 'end_turn' }
    )
    await session.settle()

    assert.equal(session.record('codex-conv-1')?.title, 'Session outcome index')
  } finally {
    session.dispose()
  }
})

test('the write set outlives the bounded recent-writes ring', async () => {
  const session = fixture()
  try {
    // Far past the session manager's 100-entry ring: the index accumulates its own set, so the
    // record still names the most recent writes rather than whatever the ring had room for.
    session.write(...Array.from({ length: 400 }, (_, index) => `D:\\Development\\ADE\\src\\file-${index}.ts`))
    session.publish(user('u1', 'Rename the symbol across the whole tree.'), assistant('a1', 'Renamed.'), {
      type: 'turn_complete',
      stopReason: 'end_turn'
    })
    await session.settle()

    const files = session.record('codex-conv-1')?.filesTouched ?? []
    assert.equal(files.length, SESSION_OUTCOME_FILES_LIMIT)
    assert.equal(files.at(-1), 'src/file-399.ts')
    assert.equal(files.at(0), `src/file-${400 - SESSION_OUTCOME_FILES_LIMIT}.ts`)
  } finally {
    session.dispose()
  }
})

test('written paths are recorded relative to the project, in the shape a reader greps for', async () => {
  const session = fixture()
  try {
    session.write('D:\\Development\\ADE\\src\\main\\index.ts', 'D:\\Development\\other\\notes.md')
    session.publish(user('u1', 'Touch one file inside the project and one outside it.'), assistant('a1', 'Done.'), {
      type: 'turn_complete',
      stopReason: 'end_turn'
    })
    await session.settle()

    // Anything outside the project stays absolute: a sibling checkout is only identifiable in full.
    assert.deepEqual(session.record('codex-conv-1')?.filesTouched, [
      'src/main/index.ts',
      'D:\\Development\\other\\notes.md'
    ])
  } finally {
    session.dispose()
  }
})

test('the write set survives the process that produced it', async () => {
  const session = fixture()
  try {
    session.write('D:\\Development\\ADE\\src\\a.ts')
    session.publish(user('u1', 'Start the work now and finish it after a restart.'), assistant('a1', 'Started.'), {
      type: 'turn_complete',
      stopReason: 'end_turn'
    })
    await session.settle()

    // A second watch on the same conversation is what a resumed dormant node looks like: it knows
    // nothing of the earlier writes, so only the record on disk can carry them forward.
    const resumed = session.rewatch()
    resumed.write('D:\\Development\\ADE\\src\\b.ts')
    session.publish(user('u2', 'Finish it.'), assistant('a2', 'Finished.'), {
      type: 'turn_complete',
      stopReason: 'end_turn'
    })
    await session.settle()

    assert.deepEqual(session.record('codex-conv-1')?.filesTouched, ['src/a.ts', 'src/b.ts'])
  } finally {
    session.dispose()
  }
})

test('a failed turn is recorded with its reason while the session stays active', async () => {
  const session = fixture()
  try {
    session.publish(user('u1', 'Package the installer.'), assistant('a1', 'It threw.'), {
      type: 'turn_failed',
      turnId: 't1',
      message: 'electron-builder exited with code 1.'
    })
    await session.settle()

    const record = session.record('codex-conv-1')
    assert.deepEqual(record?.failures, [
      { id: 't1', status: 'failed', message: 'electron-builder exited with code 1.' }
    ])
    assert.equal(record?.status, 'active')
  } finally {
    session.dispose()
  }
})

test('retiring the session finalizes a clean answered conversation as completed', async () => {
  const session = fixture()
  try {
    session.publish(user('u1', 'Finish this and I will close the node.'), assistant('a1', 'All done.'), {
      type: 'turn_complete',
      stopReason: 'end_turn'
    })
    await session.settle()
    assert.equal(session.record('codex-conv-1')?.status, 'active')

    session.close()
    await session.settle()

    assert.equal(session.record('codex-conv-1')?.status, 'completed')
  } finally {
    session.dispose()
  }
})

test('retiring the session after a failed turn finalizes it as abandoned', async () => {
  const session = fixture()
  try {
    session.publish(user('u1', 'Package the installer.'), assistant('a1', 'It threw.'), {
      type: 'turn_failed',
      turnId: 't1',
      message: 'electron-builder exited with code 1.'
    })
    session.close()
    await session.settle()

    assert.equal(session.record('codex-conv-1')?.status, 'abandoned')
  } finally {
    session.dispose()
  }
})

test('a session retired before any turn boundary leaves no record behind', async () => {
  const session = fixture()
  try {
    session.publish(user('u1', 'Open the node and close it again without asking for anything.'))
    session.close()
    await session.settle()

    assert.deepEqual(session.files(), [])
  } finally {
    session.dispose()
  }
})

import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { AgentEvent } from '../src/shared/agent'
import { createAgentEventBroker } from '../src/main/agent-event-broker'
import { createSessionOutcomeIndexer, type SessionOutcomeContext } from '../src/main/session-outcome-indexer'
import { createSessionOutcomeStore } from '../src/main/session-outcome-store'
import { parseSessionOutcome, type SessionOutcomeRecord } from '../src/shared/session-outcome'

const NOW = 1_700_000_000_000

function user(messageId: string, text: string): AgentEvent {
  return { type: 'message', role: 'user', messageId, text }
}

function assistant(messageId: string, text: string): AgentEvent {
  return { type: 'message', role: 'assistant', messageId, text, presentation: 'final' }
}

interface Fixture {
  publish(...events: AgentEvent[]): void
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
  const watch = createSessionOutcomeIndexer({
    broker,
    store: createSessionOutcomeStore({ directory }),
    ...(worktreeId ? { worktreeIdForNode: async (): Promise<string> => worktreeId } : {}),
    ...(title ? { titleFor: async (): Promise<string> => title } : {}),
    now: () => new Date((clock += 60_000)),
    log: (message) => failures.push(message)
  }).watch('node-1', () => ({
    provider: 'codex',
    conversationId: 'conv-1',
    projectPath: 'D:\\Development\\ADE',
    ...context
  }))
  const pathFor = (key: string): string => join(directory, `${key}.md`)
  return {
    publish: (...events) => {
      for (const event of events) broker.publish('node-1', event)
    },
    close: () => broker.close('node-1'),
    settle: async () => {
      await watch.idle()
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

import { mkdirSync, readFileSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseSessionOutcome, renderSessionOutcome, type SessionOutcomeRecord } from '../shared/session-outcome'
import { writeSnapshotAtomically, writeSnapshotAtomicallySync } from './durable-file'
import { createSerialQueue } from './serial-queue'

/**
 * Where session outcome records live: one Markdown file per conversation under `<userData>`,
 * brain-dump-library shape. Deliberately not SQLite - the reader is an agent running grep over a
 * sandboxed folder, and at this scale a native module plus a query round-trip would buy nothing
 * (see `docs/plans/session-outcome-index.md`).
 *
 * Writes go through the shared `writeSnapshotAtomically`, so a crash mid-write leaves the previous
 * record intact rather than a torn file, and they are serialized per store because a conversation's
 * turn boundaries can settle faster than a write completes.
 */

export interface SessionOutcomeStore {
  read(key: string): Promise<SessionOutcomeRecord | null>
  write(record: SessionOutcomeRecord): Promise<void>
  /**
   * The synchronous pair, for the one write that cannot await: `before-quit` kills every session
   * and the process is gone before any promise settles, so a status finalized asynchronously there
   * would never reach disk. Unserialized by nature - it runs to completion before anything else on
   * the event loop can - and it reads as well as writes, because finalizing is a transition on the
   * record the last turn boundary already wrote.
   */
  readSync(key: string): SessionOutcomeRecord | null
  writeSync(record: SessionOutcomeRecord): void
}

export function createSessionOutcomeStore(options: { directory: string }): SessionOutcomeStore {
  const serialize = createSerialQueue()
  const pathFor = (key: string): string => join(options.directory, `${key}.md`)

  return {
    async read(key) {
      try {
        return parseSessionOutcome(await readFile(pathFor(key), 'utf8'))
      } catch {
        // A record that is absent and a record that cannot be read mean the same thing to the
        // indexer: derive a fresh one from the transcript.
        return null
      }
    },
    write(record) {
      return serialize(async () => {
        await mkdir(options.directory, { recursive: true })
        await writeSnapshotAtomically(pathFor(record.key), renderSessionOutcome(record))
      })
    },
    readSync(key) {
      try {
        return parseSessionOutcome(readFileSync(pathFor(key), 'utf8'))
      } catch {
        return null
      }
    },
    writeSync(record) {
      mkdirSync(options.directory, { recursive: true })
      writeSnapshotAtomicallySync(pathFor(record.key), renderSessionOutcome(record), { durable: true })
    }
  }
}

import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { mkdir, readFile, readdir, rm } from 'node:fs/promises'
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

/**
 * What an `update` decided for one record: replace it, remove it, or leave the file exactly as it
 * was found - the last being what a snapshot with nothing worth recording yet asks for, and
 * deliberately distinct from removal, since "I have nothing to say about this" must never delete a
 * record another session wrote.
 */
export type SessionOutcomeUpdate = SessionOutcomeRecord | 'delete' | 'keep'

export interface SessionOutcomeStore {
  read(key: string): Promise<SessionOutcomeRecord | null>
  write(record: SessionOutcomeRecord): Promise<void>
  /**
   * Reads one record and writes back what `change` makes of it, with nothing else touching the file
   * in between. Every writer of a record is a read-modify-write - a capture merges the write set it
   * inherited, finalizing settles a status - and two sessions can hold the same conversation at
   * once, because retiring a node and resuming it are one gesture apart. Doing that as a bare
   * `read` then `write` lets the slower of the two put its stale copy back on top, which costs
   * exactly the accumulated history the record exists to carry.
   */
  update(key: string, change: (previous: SessionOutcomeRecord | null) => SessionOutcomeUpdate): Promise<void>
  /**
   * Every record the directory holds, by key, cheaply: one directory listing and no file reads, so
   * the pruner can ask "how many are there?" after every new record and only pay for their
   * contents when the answer is over the cap.
   */
  keys(): Promise<string[]>
  /** Drops one record. Absent is success: pruning and trivial-session removal both aim at the same file. */
  delete(key: string): Promise<void>
  /**
   * The synchronous pair, for the one write that cannot await: `before-quit` kills every session
   * and the process is gone before any promise settles, so a status finalized asynchronously there
   * would never reach disk. Unserialized by nature - it runs to completion before anything else on
   * the event loop can - and it reads as well as writes, because finalizing is a transition on the
   * record the last turn boundary already wrote.
   */
  readSync(key: string): SessionOutcomeRecord | null
  writeSync(record: SessionOutcomeRecord): void
  /** The synchronous `delete`, for the same reason: `before-quit` is where a trivial record is dropped. */
  deleteSync(key: string): void
}

/** The extension every record carries, and what tells one apart from an atomic write's temp file. */
const RECORD_SUFFIX = '.md'

export function createSessionOutcomeStore(options: { directory: string }): SessionOutcomeStore {
  const serialize = createSerialQueue()
  const pathFor = (key: string): string => join(options.directory, `${key}${RECORD_SUFFIX}`)

  const readRecord = async (key: string): Promise<SessionOutcomeRecord | null> => {
    try {
      return parseSessionOutcome(await readFile(pathFor(key), 'utf8'))
    } catch {
      // A record that is absent and a record that cannot be read mean the same thing to the
      // indexer: derive a fresh one from the transcript.
      return null
    }
  }

  const writeRecord = async (record: SessionOutcomeRecord): Promise<void> => {
    await mkdir(options.directory, { recursive: true })
    await writeSnapshotAtomically(pathFor(record.key), renderSessionOutcome(record))
  }

  return {
    read: readRecord,
    write(record) {
      return serialize(() => writeRecord(record))
    },
    update(key, change) {
      // The read is inside the queue, which is the whole point: everything else here would work
      // just as well outside it, and would be a lost update.
      return serialize(async () => {
        const next = change(await readRecord(key))
        if (next === 'keep') return
        if (next === 'delete') await rm(pathFor(key), { force: true })
        else await writeRecord(next)
      })
    },
    async keys() {
      try {
        // Filtered on the suffix rather than on file type, because that is also what excludes the
        // `.md.tmp-<uuid>` file an atomic write leaves in flight: counting one of those as a record
        // would prune a real one to make room for something that is about to rename itself away.
        return (await readdir(options.directory))
          .filter((name) => name.endsWith(RECORD_SUFFIX))
          .map((name) => name.slice(0, -RECORD_SUFFIX.length))
      } catch {
        // No directory yet is no records yet, which is what a pruner concludes from it anyway.
        return []
      }
    },
    delete(key) {
      // Serialized with writes for the same reason they are serialized with each other: a record
      // pruned while its own capture is mid-rename would land back on disk a moment later.
      return serialize(async () => {
        await rm(pathFor(key), { force: true })
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
    },
    deleteSync(key) {
      rmSync(pathFor(key), { force: true })
    }
  }
}

import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseSessionOutcome, renderSessionOutcome, type SessionOutcomeRecord } from '../shared/session-outcome'
import { writeSnapshotAtomically } from './durable-file'
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
    }
  }
}

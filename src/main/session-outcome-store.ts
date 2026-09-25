import { mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { mkdir, readFile, readdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import {
  parseSessionOutcome,
  renderSessionOutcome,
  sessionOutcomeFileName,
  sessionOutcomeShortIdSuffix,
  type SessionOutcomeIdentity,
  type SessionOutcomeRecord
} from '../shared/session-outcome'
import { writeSnapshotAtomically, writeSnapshotAtomicallySync } from './durable-file'
import { createSerialQueue } from './serial-queue'

/**
 * Where session outcome records live: one Markdown file per conversation under `<userData>`,
 * brain-dump-library shape. Deliberately not SQLite - the reader is an agent running grep over a
 * sandboxed folder, and at this scale a native module plus a query round-trip would buy nothing
 * (see `docs/plans/session-outcome-index.md`).
 *
 * Since Tucaen/toucan#18 a record's filename is descriptive (`sessionOutcomeFileName`: project,
 * title, shortid) rather than its key, so stage one of an agent's read - the directory listing -
 * already names what every record is about. That splits identity from location: a conversation is
 * *found* by the `--<shortid>.md` suffix and confirmed against the `provider`/`conversation`
 * frontmatter, and a capture whose title slug changed moves the record to its new name. The lookup
 * is a directory listing plus at most a couple of candidate reads, paid once per turn boundary.
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

/**
 * How an `update` names the file it writes. Supplied only by the capture path: a capture renames
 * the record when its title slug changed, while finalizing - a status transition on a record some
 * capture already placed - writes back to the name it found, because it has no checkout lookup and
 * recomputing would move a worktree session's record under its worktree folder's name.
 */
export interface SessionOutcomeNaming {
  /** The main checkout the session's directory belongs to, where it runs in a worktree of one. */
  checkoutPath?: string
}

export interface SessionOutcomeStore {
  read(identity: SessionOutcomeIdentity): Promise<SessionOutcomeRecord | null>
  write(record: SessionOutcomeRecord, naming?: SessionOutcomeNaming): Promise<void>
  /**
   * Reads one record and writes back what `change` makes of it, with nothing else touching the file
   * in between. Every writer of a record is a read-modify-write - a capture merges the write set it
   * inherited, finalizing settles a status - and two sessions can hold the same conversation at
   * once, because retiring a node and resuming it are one gesture apart. Doing that as a bare
   * `read` then `write` lets the slower of the two put its stale copy back on top, which costs
   * exactly the accumulated history the record exists to carry.
   */
  update(
    identity: SessionOutcomeIdentity,
    change: (previous: SessionOutcomeRecord | null) => SessionOutcomeUpdate,
    naming?: SessionOutcomeNaming
  ): Promise<void>
  /**
   * Every record file the directory holds, by name, cheaply: one directory listing and no file
   * reads, so the pruner can ask "how many are there?" after every new record and only pay for
   * their contents when the answer is over the cap.
   */
  files(): Promise<string[]>
  /** One file by its listed name - what pruning reads, since a filename is not an identity. */
  readFile(name: string): Promise<SessionOutcomeRecord | null>
  /** Drops one file by its listed name. Absent is success: pruning aims at whatever `files` listed. */
  deleteFile(name: string): Promise<void>
  /** Drops a conversation's record wherever its title has moved it. Absent is success. */
  delete(identity: SessionOutcomeIdentity): Promise<void>
  /**
   * The synchronous pair, for the one write that cannot await: `before-quit` kills every session
   * and the process is gone before any promise settles, so a status finalized asynchronously there
   * would never reach disk. Unserialized by nature - it runs to completion before anything else on
   * the event loop can - and it reads as well as writes, because finalizing is a transition on the
   * record the last turn boundary already wrote (and it writes back to the file it found it in).
   */
  readSync(identity: SessionOutcomeIdentity): SessionOutcomeRecord | null
  writeSync(record: SessionOutcomeRecord): void
  /** The synchronous `delete`, for the same reason: `before-quit` is where a trivial record is dropped. */
  deleteSync(identity: SessionOutcomeIdentity): void
}

/** The extension every record carries, and what tells one apart from an atomic write's temp file. */
const RECORD_SUFFIX = '.md'

/** A record found on disk: where it is and what it says. */
interface LocatedRecord {
  name: string
  record: SessionOutcomeRecord
}

export function createSessionOutcomeStore(options: { directory: string }): SessionOutcomeStore {
  const serialize = createSerialQueue()
  const pathFor = (name: string): string => join(options.directory, `${name}${RECORD_SUFFIX}`)

  const listNames = async (): Promise<string[]> => {
    try {
      // Filtered on the suffix rather than on file type, because that is also what excludes the
      // `.md.tmp-<uuid>` file an atomic write leaves in flight: counting one of those as a record
      // would prune a real one to make room for something that is about to rename itself away.
      return (await readdir(options.directory))
        .filter((name) => name.endsWith(RECORD_SUFFIX))
        .map((name) => name.slice(0, -RECORD_SUFFIX.length))
    } catch {
      // No directory yet is no records yet, which is what every caller concludes from it anyway.
      return []
    }
  }

  const readNamed = async (name: string): Promise<SessionOutcomeRecord | null> => {
    try {
      return parseSessionOutcome(await readFile(pathFor(name), 'utf8'))
    } catch {
      // A record that is absent and a record that cannot be read mean the same thing to the
      // indexer: derive a fresh one from the transcript.
      return null
    }
  }

  /** Whether a parsed record is the conversation a filename hit claimed it is. */
  const confirms = (record: SessionOutcomeRecord, identity: SessionOutcomeIdentity): boolean =>
    record.provider === identity.provider && record.conversationId === identity.conversationId

  /**
   * Freshest record first; ties break on the name so an interrupted rename resolves the same way
   * on every lookup. One rule for both the async and the sync locate, so it cannot drift.
   */
  const freshestFirst = (a: LocatedRecord, b: LocatedRecord): number =>
    b.record.updatedAt.localeCompare(a.record.updatedAt) || a.name.localeCompare(b.name)

  /**
   * Every file the identity's shortid suffix names, confirmed against the frontmatter so a shortid
   * collision costs a candidate read and never a wrong record. More than one confirmed file is a
   * rename interrupted between write and cleanup: the freshest is the record, and the caller that
   * writes deletes the rest, which is what makes "no duplicate file is left behind" self-healing
   * rather than dependent on every rename completing.
   */
  const locate = async (
    identity: SessionOutcomeIdentity
  ): Promise<{ current: LocatedRecord | null; stale: string[] }> => {
    const suffix = sessionOutcomeShortIdSuffix(identity.conversationId)
    const confirmed: LocatedRecord[] = []
    for (const name of (await listNames()).filter((name) => name.endsWith(suffix))) {
      const record = await readNamed(name)
      if (record && confirms(record, identity)) confirmed.push({ name, record })
    }
    confirmed.sort(freshestFirst)
    const [current = null, ...rest] = confirmed
    return { current, stale: rest.map((located) => located.name) }
  }

  const writeNamed = async (name: string, record: SessionOutcomeRecord): Promise<void> => {
    await mkdir(options.directory, { recursive: true })
    await writeSnapshotAtomically(pathFor(name), renderSessionOutcome(record))
  }

  /**
   * The write behind both `write` and `update`: place the record, then remove whatever other file
   * still carried this conversation - the old title's name, or a duplicate an interrupted rename
   * left. Write-then-remove, so a crash between the two leaves a duplicate the next capture heals
   * rather than a conversation with no record at all.
   */
  const place = async (
    record: SessionOutcomeRecord,
    current: LocatedRecord | null,
    stale: string[],
    naming: SessionOutcomeNaming | undefined
  ): Promise<void> => {
    const target = naming
      ? sessionOutcomeFileName(record, naming.checkoutPath)
      : (current?.name ?? sessionOutcomeFileName(record))
    await writeNamed(target, record)
    for (const name of [current?.name, ...stale]) {
      if (name && name !== target) await rm(pathFor(name), { force: true })
    }
  }

  /**
   * One-time rename of pre-#18 records (`<provider>-<conversationId>.md`) to the descriptive
   * scheme, queued at creation so every keyed operation runs behind it. Idempotent because a
   * migrated name always carries the `--` separator no old key of a UUID-shaped id has, and cheap
   * on every later startup for the same reason: nothing without `--` is left to parse. An
   * unreadable record is left alone - it is invisible to keyed lookups either way, and pruning
   * drops it first. The checkout is unknown here, so a worktree session's old record migrates
   * under its recorded project folder's name; the next capture renames it against the checkout.
   */
  const migrate = async (): Promise<void> => {
    for (const name of await listNames()) {
      if (name.includes('--')) continue
      const record = await readNamed(name)
      if (!record) continue
      const target = sessionOutcomeFileName(record)
      if (target === name) continue
      try {
        // A plain rename: same directory, and either name surviving a crash is a complete record.
        await rename(pathFor(name), pathFor(target))
      } catch {
        // A file that cannot move stays readable where it is and ages out through pruning.
      }
    }
  }
  // Queued first, so every serialized operation runs behind it; the unserialized async reads await
  // it explicitly instead, because a lookup racing the renames would read a record as absent.
  const migrated = serialize(migrate)

  const locateSync = (identity: SessionOutcomeIdentity): LocatedRecord | null => {
    const suffix = sessionOutcomeShortIdSuffix(identity.conversationId)
    let names: string[]
    try {
      names = readdirSync(options.directory)
        .filter((name) => name.endsWith(RECORD_SUFFIX))
        .map((name) => name.slice(0, -RECORD_SUFFIX.length))
    } catch {
      return null
    }
    const confirmed: LocatedRecord[] = []
    for (const name of names.filter((name) => name.endsWith(suffix))) {
      try {
        const record = parseSessionOutcome(readFileSync(pathFor(name), 'utf8'))
        if (record && confirms(record, identity)) confirmed.push({ name, record })
      } catch {
        // Unreadable is absent, exactly as the async path reads it.
      }
    }
    confirmed.sort(freshestFirst)
    return confirmed[0] ?? null
  }

  return {
    async read(identity) {
      await migrated
      return (await locate(identity)).current?.record ?? null
    },
    write(record, naming) {
      return serialize(async () => {
        const { current, stale } = await locate(record)
        await place(record, current, stale, naming)
      })
    },
    update(identity, change, naming) {
      // The read is inside the queue, which is the whole point: everything else here would work
      // just as well outside it, and would be a lost update.
      return serialize(async () => {
        const { current, stale } = await locate(identity)
        const next = change(current?.record ?? null)
        if (next === 'keep') return
        if (next === 'delete') {
          for (const name of [current?.name, ...stale]) if (name) await rm(pathFor(name), { force: true })
          return
        }
        await place(next, current, stale, naming)
      })
    },
    files: listNames,
    readFile: readNamed,
    deleteFile(name) {
      // Serialized with writes for the same reason they are serialized with each other: a record
      // pruned while its own capture is mid-rename would land back on disk a moment later.
      return serialize(async () => {
        await rm(pathFor(name), { force: true })
      })
    },
    delete(identity) {
      return serialize(async () => {
        const { current, stale } = await locate(identity)
        for (const name of [current?.name, ...stale]) if (name) await rm(pathFor(name), { force: true })
      })
    },
    readSync(identity) {
      return locateSync(identity)?.record ?? null
    },
    writeSync(record) {
      // Written back to the file it was found in - finalizing never renames - and only computed
      // fresh for a record that has none, which the finalize path never produces ('keep' on null).
      const name = locateSync(record)?.name ?? sessionOutcomeFileName(record)
      mkdirSync(options.directory, { recursive: true })
      writeSnapshotAtomicallySync(pathFor(name), renderSessionOutcome(record), { durable: true })
    },
    deleteSync(identity) {
      const located = locateSync(identity)
      if (located) rmSync(pathFor(located.name), { force: true })
    }
  }
}

/**
 * The one durable JSON store behind main's simple single-file stores (conversation titles,
 * brain-dump capture, terminal liveness, remote-access settings, adapter selection). The protocol
 * is identical for all of them - read the file, validate through a parse predicate, fall back to a
 * default on a missing or damaged one, and replace the file atomically on every write - so a store
 * is a parse predicate and a fallback, nothing more. Stores with a richer protocol
 * (`workspace-store`'s backup promotion, `terminal-scrollback-store`'s pending marker)
 * deliberately do not fit here: they build directly on `durable-file` instead of growing this one
 * into a switchboard.
 *
 * "Unreadable" is two different answers and this store keeps them apart (#223). `ENOENT` means
 * there is no file yet, which the fallback is exactly right for. Every other read failure - the
 * EBUSY/EACCES/EPERM an antivirus or indexer hold produces on Windows at startup - means a file
 * that may still hold good data, and a store that answered those with the fallback would let the
 * next `save` atomically replace user renames and adapter selections with defaults. So a read that
 * fails for any other reason leaves the store read-only and logged until a re-read succeeds:
 * nothing is written over a file this store has not read.
 */
import { mkdirSync, readFileSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { errorMessage } from '../shared/text'
import { writeSnapshotAtomically, writeSnapshotAtomicallySync } from './durable-file'
import { createSerialQueue } from './serial-queue'

export interface DurableJsonStoreOptions<T> {
  path: string
  /** Validates one parsed file; null means unusable, and the fallback takes its place. */
  parse(value: unknown): T | null
  fallback(): T
  /** Receives the reason a read failed, so a store that stops persisting is never silent. */
  log?(message: string): void
}

/** The one read failure that means "there is no file yet" rather than "this file is out of reach". */
function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

/** What both variants log when they give up on a file that exists, so the two never drift apart. */
function unreadableMessage(path: string, error: unknown): string {
  return `could not read ${path}, so nothing will be written over it: ${errorMessage(error)}`
}

export interface DurableJsonStore<T> {
  /**
   * The current value: the validated file on first call, then whatever was last saved. Rejects
   * while the file exists but cannot be read; the next call reads it again, so a transient hold
   * ends by itself.
   */
  load(): Promise<T>
  /**
   * Queued atomic write; a rejected save reports to its caller and never poisons the next. A store
   * that has not managed to read its file rejects here too rather than replacing it.
   */
  save(value: T): Promise<void>
  /**
   * Queued read-modify-write. `mutate` runs against the latest value once every earlier write has
   * settled; returning the current value verbatim skips the disk write entirely.
   */
  update<R>(mutate: (current: T) => { value: T; result: R }): Promise<R>
}

function readValidated<T>(contents: string, options: DurableJsonStoreOptions<T>): T {
  try {
    return options.parse(JSON.parse(contents) as unknown) ?? options.fallback()
  } catch {
    return options.fallback()
  }
}

function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

export function createDurableJsonStore<T>(options: DurableJsonStoreOptions<T>): DurableJsonStore<T> {
  const enqueue = createSerialQueue()
  // The in-memory value stays the one in force even when a disk write fails: the caller is told,
  // and the next write starts again from this state rather than from the stale file.
  let current: { value: T } | null = null
  let reading: Promise<T> | null = null

  const load = (): Promise<T> => {
    if (current) return Promise.resolve(current.value)
    reading ??= readFile(options.path, 'utf8')
      .then(
        (contents) => readValidated(contents, options),
        (error: unknown) => {
          if (isMissingFile(error)) return options.fallback()
          // Drop the cached attempt so the next caller reads the file again: the hold that made it
          // unreachable is usually over in seconds, and nothing may be written until it is.
          reading = null
          options.log?.(unreadableMessage(options.path, error))
          throw error
        }
      )
      .then((value) => {
        // A save that raced the first read has already established the value in force.
        current ??= { value }
        return current.value
      })
    return reading
  }

  const write = async (value: T): Promise<void> => {
    current = { value }
    await mkdir(dirname(options.path), { recursive: true })
    await writeSnapshotAtomically(options.path, serialize(value))
  }

  return {
    load,
    // The read comes first even here: a `save` is the operation that would destroy an unread file,
    // and once the first read has landed `load` resolves from memory and costs nothing.
    save: (value) =>
      enqueue(async () => {
        await load()
        await write(value)
      }),
    update: (mutate) =>
      enqueue(async () => {
        const before = await load()
        const { value, result } = mutate(before)
        if (value !== before) await write(value)
        return result
      })
  }
}

export interface DurableJsonStoreSync<T> {
  read(): T
  /**
   * Atomic and fsynced, synchronously - for values that must be on disk before this call returns
   * (`before-quit` verdicts, the pairing token). A failed write is swallowed by design: the
   * in-memory value stays the one in force and the next save writes the whole state again. A store
   * whose file could not be read writes nothing at all for the rest of its life; the re-read that
   * could let it out of that state is the next process reopening the store.
   */
  save(value: T): void
}

export function createDurableJsonStoreSync<T>(options: DurableJsonStoreOptions<T>): DurableJsonStoreSync<T> {
  let value: T
  /**
   * Set when the file existed but could not be read, and never cleared. Its callers mirror
   * `read()` once at construction and then persist their whole state, so a store that recovered
   * mid-life would hand the very next `save` a value derived from the fallback to write over the
   * file it just managed to read - the loss this guard exists to prevent, one save later. Staying
   * read-only costs this run's writes and nothing on disk.
   */
  let unread = false

  try {
    value = readValidated(readFileSync(options.path, 'utf8'), options)
  } catch (error) {
    value = options.fallback()
    if (!isMissingFile(error)) {
      unread = true
      options.log?.(unreadableMessage(options.path, error))
    }
  }

  return {
    read: () => value,
    save(next): void {
      if (unread) return
      value = next
      try {
        mkdirSync(dirname(options.path), { recursive: true })
        writeSnapshotAtomicallySync(options.path, serialize(next), { durable: true })
      } catch {
        // Best-effort persistence; the in-memory value above is still the one in force.
      }
    }
  }
}

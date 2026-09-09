/**
 * The one durable JSON store behind main's simple single-file stores (conversation titles,
 * brain-dump capture, terminal liveness, remote-access settings, adapter selection). The protocol
 * is identical for all of them - read the file, validate through a parse predicate, fall back to a
 * default on anything unreadable, and replace the file atomically on every write - so a store is a
 * parse predicate and a fallback, nothing more. Stores with a richer protocol (`workspace-store`'s
 * backup promotion, `terminal-scrollback-store`'s pending marker) deliberately do not fit here:
 * they build directly on `durable-file` instead of growing this one into a switchboard.
 */
import { mkdirSync, readFileSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { writeSnapshotAtomically, writeSnapshotAtomicallySync } from './durable-file'
import { createSerialQueue } from './serial-queue'

export interface DurableJsonStoreOptions<T> {
  path: string
  /** Validates one parsed file; null means unusable, and the fallback takes its place. */
  parse(value: unknown): T | null
  fallback(): T
}

export interface DurableJsonStore<T> {
  /** The current value: the validated file on first call, then whatever was last saved. */
  load(): Promise<T>
  /** Queued atomic write; a rejected save reports to its caller and never poisons the next. */
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
        () => options.fallback()
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
    save: (value) => enqueue(() => write(value)),
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
   * in-memory value stays the one in force and the next save writes the whole state again.
   */
  save(value: T): void
}

export function createDurableJsonStoreSync<T>(options: DurableJsonStoreOptions<T>): DurableJsonStoreSync<T> {
  let value: T
  try {
    value = readValidated(readFileSync(options.path, 'utf8'), options)
  } catch {
    value = options.fallback()
  }

  return {
    read: () => value,
    save(next): void {
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

import { watch } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { BrainDumpCollection } from '../shared/brain-dump'

const COLLECTIONS: readonly BrainDumpCollection[] = ['active', 'archived']
const DEFAULT_DEBOUNCE_MS = 100

export interface BrainDumpChangeOwner {
  isDestroyed(): boolean
  send(channel: string, collection: BrainDumpCollection): void
}

interface DirectoryWatcher {
  close(): void
  on?(event: 'error', listener: (error: Error) => void): unknown
}

type WatchDirectory = (
  path: string,
  listener: (eventType: string, filename: string | Buffer | null) => void
) => DirectoryWatcher

export interface BrainDumpChangeWatcher {
  subscribe(owner: BrainDumpChangeOwner): void
  disconnectOwner(owner: BrainDumpChangeOwner): void
  shutdown(): void
}

export interface BrainDumpChangeWatcherOptions {
  rootDirectory: string
  debounceMs?: number
  watchDirectory?: WatchDirectory
}

/**
 * Watches the two disk-backed collections and publishes one coalesced event per changed
 * collection. Skills and editors may write with several rename/link operations, so raw fs.watch
 * events are deliberately not exposed to the renderer.
 */
export async function createBrainDumpChangeWatcher(
  options: BrainDumpChangeWatcherOptions
): Promise<BrainDumpChangeWatcher> {
  const owners = new Set<BrainDumpChangeOwner>()
  const timers = new Map<BrainDumpCollection, NodeJS.Timeout>()
  const watchDirectory: WatchDirectory = options.watchDirectory ?? ((path, listener) => watch(path, listener))
  const directories = COLLECTIONS.map((collection) => join(options.rootDirectory, collection))
  await Promise.all(directories.map((directory) => mkdir(directory, { recursive: true })))

  const publish = (collection: BrainDumpCollection): void => {
    timers.delete(collection)
    for (const owner of owners) {
      if (owner.isDestroyed()) owners.delete(owner)
      else owner.send('brain-dump:library-change', collection)
    }
  }

  const schedule = (collection: BrainDumpCollection): void => {
    const pending = timers.get(collection)
    if (pending) clearTimeout(pending)
    const timer = setTimeout(() => publish(collection), options.debounceMs ?? DEFAULT_DEBOUNCE_MS)
    timer.unref()
    timers.set(collection, timer)
  }

  const watchers = COLLECTIONS.map((collection, index) => {
    const watcher = watchDirectory(directories[index], (_eventType, filename) => {
      // A missing filename means the platform cannot identify the entry, so conservatively refresh.
      // Otherwise only Markdown topics matter; durable-write temporary files are ignored.
      if (filename === null || filename.toString().toLowerCase().endsWith('.md')) schedule(collection)
    })
    // Avoid an unhandled EventEmitter error taking down Toucan. The directories are created before
    // watching; a later failure simply stops that OS watcher until Toucan restarts.
    watcher.on?.('error', () => {})
    return watcher
  })

  return {
    subscribe: (owner) => owners.add(owner),
    disconnectOwner: (owner) => owners.delete(owner),
    shutdown: () => {
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
      for (const watcher of watchers) watcher.close()
      owners.clear()
    }
  }
}

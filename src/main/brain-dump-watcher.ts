import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { BrainDumpCollection } from '../shared/brain-dump'
import { BRAIN_DUMP_CHANNELS } from '../shared/ipc-channels'
import { createWatchedDirectories, type WatchDirectory } from './watched-directories'

const COLLECTIONS: readonly BrainDumpCollection[] = ['active', 'archived']

export interface BrainDumpChangeOwner {
  isDestroyed(): boolean
  send(channel: string, collection: BrainDumpCollection): void
}

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
 * collection; the debounce and owner bookkeeping live in the shared `watched-directories`
 * mechanism. This policy's own decisions: the fixed collection set, directories created before
 * watching, only Markdown topics matter, and watchers are held for the life of the process.
 */
export async function createBrainDumpChangeWatcher(
  options: BrainDumpChangeWatcherOptions
): Promise<BrainDumpChangeWatcher> {
  const watches = createWatchedDirectories({
    channel: BRAIN_DUMP_CHANNELS.libraryChange,
    debounceMs: options.debounceMs,
    watchDirectory: options.watchDirectory
  })
  const directories = COLLECTIONS.map((collection) => join(options.rootDirectory, collection))
  await Promise.all(directories.map((directory) => mkdir(directory, { recursive: true })))
  COLLECTIONS.forEach((collection, index) => {
    watches.open(collection, {
      directory: directories[index],
      // Durable-write temporary files are not Markdown, so they never publish.
      matches: (filename) => filename.toLowerCase().endsWith('.md')
    })
  })

  return {
    subscribe: (owner) => watches.subscribe(owner),
    disconnectOwner: (owner) => watches.disconnectOwner(owner),
    shutdown: () => watches.shutdown()
  }
}

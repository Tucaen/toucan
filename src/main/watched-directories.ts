import { watch } from 'node:fs'

const DEFAULT_DEBOUNCE_MS = 100

export interface DirectoryChangeOwner {
  isDestroyed(): boolean
  send(channel: string, payload: string): void
}

export interface DirectoryWatcher {
  close(): void
  on?(event: 'error', listener: (error: Error) => void): unknown
}

export type WatchDirectory = (
  path: string,
  listener: (eventType: string, filename: string | Buffer | null) => void
) => DirectoryWatcher

export interface OpenWatchedDirectory {
  directory: string
  /** What owners are sent when the key settles. Defaults to the key itself. */
  payload?: string
  /**
   * Which named entries matter. A change the platform cannot name always refreshes, and omitting
   * the filter means every entry does.
   */
  matches?(filename: string): boolean
}

export interface WatchedDirectoriesOptions {
  /** The renderer channel every publish goes out on. */
  channel: string
  debounceMs?: number
  watchDirectory?: WatchDirectory
  /**
   * Release policy hook: a key stopped being held, through `unhold` (including of a key with no
   * recorded holders - an unwatch racing its own setup must still release), `disconnectOwner`, or
   * destroyed-owner pruning. The mechanism never closes a watcher on its own signal - a caller
   * that wants unheld keys released passes `(key) => watches.close(key)`; one that keeps
   * watchers for the life of the process passes nothing.
   */
  onUnheld?(key: string): void
}

export interface WatchedDirectories {
  /** Opens a debounced watcher under this key, replacing any previous one. Throws what `watchDirectory` throws. */
  open(key: string, options: OpenWatchedDirectory): void
  has(key: string): boolean
  close(key: string): void
  closeAll(): void
  /** An owner that receives every key's changes, whatever it holds. */
  subscribe(owner: DirectoryChangeOwner): void
  /** Counted interest in one key; the same owner may hold a key once per view of it. */
  hold(key: string, owner: DirectoryChangeOwner): void
  unhold(key: string, owner: DirectoryChangeOwner): void
  isHeldBy(key: string, owner: DirectoryChangeOwner): boolean
  disconnectOwner(owner: DirectoryChangeOwner): void
  hasOwners(): boolean
  shutdown(): void
}

interface WatchEntry {
  payload: string
  watcher: DirectoryWatcher
  timer?: NodeJS.Timeout
}

/**
 * The one debounced directory-watcher mechanism behind the brain-dump, ticket and file-view
 * watchers (issue #164). It owns what those three had triplicated - the per-key debounce with
 * unref'd timers, the owner bookkeeping with destroyed-owner pruning, the null-filename rule,
 * and error swallowing on the OS watcher - while each caller keeps only its policy: key and
 * payload, filename filter, and when a watcher is released.
 *
 * Raw `fs.watch` events are deliberately coalesced per key before anything is published: one
 * durable save is a rename/write burst, and an editor several more.
 *
 * Two membership shapes cover the three policies. `subscribe` is a window that hears every key
 * (brain-dump collections, ticket projects); `hold` is counted per owner and key (two file nodes
 * on one file must not blind each other), and losing a key's last holder reports through
 * `onUnheld` so the release decision stays with the caller. `shutdown` releases everything
 * without those callbacks - there is no policy left to consult.
 */
export function createWatchedDirectories(options: WatchedDirectoriesOptions): WatchedDirectories {
  const watchDirectory: WatchDirectory = options.watchDirectory ?? ((path, listener) => watch(path, listener))
  const owners = new Set<DirectoryChangeOwner>()
  const holders = new Map<string, Map<DirectoryChangeOwner, number>>()
  const watches = new Map<string, WatchEntry>()

  const droppedLastHold = (key: string, byOwner: Map<DirectoryChangeOwner, number>): void => {
    if (byOwner.size > 0) return
    holders.delete(key)
    options.onUnheld?.(key)
  }

  const publish = (key: string): void => {
    const entry = watches.get(key)
    if (!entry) return
    entry.timer = undefined
    for (const owner of owners) {
      if (owner.isDestroyed()) owners.delete(owner)
      else owner.send(options.channel, entry.payload)
    }
    const byOwner = holders.get(key)
    if (!byOwner) return
    for (const owner of [...byOwner.keys()]) {
      if (owner.isDestroyed()) byOwner.delete(owner)
      // A holder that is also subscribed was already sent this change above.
      else if (!owners.has(owner)) owner.send(options.channel, entry.payload)
    }
    droppedLastHold(key, byOwner)
  }

  const schedule = (key: string): void => {
    const entry = watches.get(key)
    if (!entry) return
    if (entry.timer) clearTimeout(entry.timer)
    const timer = setTimeout(() => publish(key), options.debounceMs ?? DEFAULT_DEBOUNCE_MS)
    timer.unref()
    entry.timer = timer
  }

  const close = (key: string): void => {
    const entry = watches.get(key)
    if (!entry) return
    if (entry.timer) clearTimeout(entry.timer)
    entry.watcher.close()
    watches.delete(key)
  }

  return {
    open: (key, { directory, payload, matches }) => {
      const watcher = watchDirectory(directory, (_eventType, filename) => {
        // A missing filename means the platform cannot identify the entry, so conservatively refresh.
        const name = filename?.toString()
        if (name === undefined || !matches || matches(name)) schedule(key)
      })
      // An unhandled EventEmitter error must not take Toucan down. A directory deleted under a
      // live watcher simply stops reporting until the caller watches it again.
      watcher.on?.('error', () => {})
      close(key)
      watches.set(key, { payload: payload ?? key, watcher })
    },
    has: (key) => watches.has(key),
    close,
    closeAll: () => {
      for (const key of [...watches.keys()]) close(key)
    },
    subscribe: (owner) => owners.add(owner),
    hold: (key, owner) => {
      const byOwner = holders.get(key) ?? new Map<DirectoryChangeOwner, number>()
      byOwner.set(owner, (byOwner.get(owner) ?? 0) + 1)
      holders.set(key, byOwner)
    },
    unhold: (key, owner) => {
      const byOwner = holders.get(key)
      if (!byOwner) {
        options.onUnheld?.(key)
        return
      }
      const count = (byOwner.get(owner) ?? 0) - 1
      if (count > 0) byOwner.set(owner, count)
      else byOwner.delete(owner)
      droppedLastHold(key, byOwner)
    },
    isHeldBy: (key, owner) => holders.get(key)?.has(owner) ?? false,
    disconnectOwner: (owner) => {
      owners.delete(owner)
      for (const [key, byOwner] of [...holders]) {
        if (byOwner.delete(owner)) droppedLastHold(key, byOwner)
      }
    },
    hasOwners: () => owners.size > 0,
    shutdown: () => {
      owners.clear()
      holders.clear()
      for (const key of [...watches.keys()]) close(key)
    }
  }
}

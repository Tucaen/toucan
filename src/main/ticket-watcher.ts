import { watch } from 'node:fs'

const DEFAULT_DEBOUNCE_MS = 100

export interface TicketChangeOwner {
  isDestroyed(): boolean
  send(channel: string, projectPath: string): void
}

interface DirectoryWatcher {
  close(): void
  on?(event: 'error', listener: (error: Error) => void): unknown
}

type WatchDirectory = (
  path: string,
  listener: (eventType: string, filename: string | Buffer | null) => void
) => DirectoryWatcher

export interface TicketChangeWatcher {
  /** Starts watching a project's tickets folder. Idempotent: the board calls it on every list. */
  watchProject(projectPath: string): Promise<void>
  subscribe(owner: TicketChangeOwner): void
  disconnectOwner(owner: TicketChangeOwner): void
  shutdown(): void
}

export interface TicketChangeWatcherOptions {
  directoryFor(projectPath: string): string | Promise<string>
  debounceMs?: number
  watchDirectory?: WatchDirectory
}

/**
 * Watches each open project's tickets folder and publishes one coalesced event per project. Unlike
 * the brain-dump watcher there is no fixed set of folders: a project is watched the first time its
 * board is listed and stays watched while a window is listening, because a board the user switched
 * away from is the one most likely to have been edited behind their back.
 *
 * A project with no tickets folder is not watched, and no folder is created to make one watchable:
 * Toucan does not write into someone's checkout because they opened a board. Such a project stays
 * unclaimed and is retried on its next listing.
 *
 * Raw `fs.watch` events are deliberately not exposed: an agent writing a ticket produces a
 * rename/write pair, and an editor several more.
 */
export function createTicketChangeWatcher(options: TicketChangeWatcherOptions): TicketChangeWatcher {
  const owners = new Set<TicketChangeOwner>()
  const timers = new Map<string, NodeJS.Timeout>()
  const watchers = new Map<string, DirectoryWatcher>()
  /** Claimed before the first await, so two concurrent lists cannot open two watchers on a folder. */
  const claimed = new Set<string>()
  const watchDirectory: WatchDirectory = options.watchDirectory ?? ((path, listener) => watch(path, listener))
  let stopped = false

  const releaseWatchers = (): void => {
    for (const timer of timers.values()) clearTimeout(timer)
    timers.clear()
    for (const watcher of watchers.values()) watcher.close()
    watchers.clear()
    claimed.clear()
  }

  const publish = (projectPath: string): void => {
    timers.delete(projectPath)
    for (const owner of owners) {
      if (owner.isDestroyed()) owners.delete(owner)
      else owner.send('tickets:changed', projectPath)
    }
  }

  const schedule = (projectPath: string): void => {
    const pending = timers.get(projectPath)
    if (pending) clearTimeout(pending)
    const timer = setTimeout(() => publish(projectPath), options.debounceMs ?? DEFAULT_DEBOUNCE_MS)
    timer.unref()
    timers.set(projectPath, timer)
  }

  return {
    watchProject: async (projectPath) => {
      if (stopped || claimed.has(projectPath)) return
      claimed.add(projectPath)
      try {
        const folder = await options.directoryFor(projectPath)
        if (stopped) return
        const watcher = watchDirectory(folder, (_eventType, filename) => {
          // A missing filename means the platform cannot identify the entry, so refresh anyway.
          // Otherwise only Markdown matters; durable-write temporaries are dotfiles.
          const name = filename?.toString()
          if (name === undefined || (name.toLowerCase().endsWith('.md') && !name.startsWith('.'))) {
            schedule(projectPath)
          }
        })
        // An EventEmitter error must not take Toucan down. A folder deleted under a live watcher
        // simply stops reporting until Toucan restarts; the board still lists on demand.
        watcher.on?.('error', () => {})
        watchers.set(projectPath, watcher)
      } catch {
        // Nothing to watch yet: a project that has never filed a ticket has no folder, and Toucan
        // does not create one in someone's checkout just to look at it. Unclaimed, so the next
        // listing tries again - which is what the board's Refresh is for once the folder appears.
        claimed.delete(projectPath)
      }
    },
    subscribe: (owner) => owners.add(owner),
    disconnectOwner: (owner) => {
      owners.delete(owner)
      // Nobody left to tell. Holding OS watch handles for a window that is gone (or for a project
      // since removed from the workspace) leaks them for the life of the process; the next window
      // re-watches on its first listing.
      if (owners.size === 0) releaseWatchers()
    },
    shutdown: () => {
      stopped = true
      releaseWatchers()
      owners.clear()
    }
  }
}

import { TICKET_CHANNELS } from '../shared/ipc-channels'
import { createWatchedDirectories, type WatchDirectory } from './watched-directories'

export interface TicketChangeOwner {
  isDestroyed(): boolean
  send(channel: string, projectPath: string): void
}

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
 * Watches each open project's tickets folder and publishes one coalesced event per project; the
 * debounce and owner bookkeeping live in the shared `watched-directories` mechanism. Unlike the
 * brain-dump watcher there is no fixed set of folders: a project is watched the first time its
 * board is listed and stays watched while a window is listening, because a board the user switched
 * away from is the one most likely to have been edited behind their back.
 *
 * A project with no tickets folder is not watched, and no folder is created to make one watchable:
 * Toucan does not write into someone's checkout because they opened a board. Such a project stays
 * unclaimed and is retried on its next listing.
 */
export function createTicketChangeWatcher(options: TicketChangeWatcherOptions): TicketChangeWatcher {
  const watches = createWatchedDirectories({
    channel: TICKET_CHANNELS.changed,
    debounceMs: options.debounceMs,
    watchDirectory: options.watchDirectory
  })
  /** Claimed before the first await, so two concurrent lists cannot open two watchers on a folder. */
  const claimed = new Set<string>()
  let stopped = false

  return {
    watchProject: async (projectPath) => {
      if (stopped || claimed.has(projectPath)) return
      claimed.add(projectPath)
      try {
        const folder = await options.directoryFor(projectPath)
        if (stopped) return
        watches.open(projectPath, {
          directory: folder,
          // Only Markdown matters; durable-write temporaries are dotfiles.
          matches: (filename) => filename.toLowerCase().endsWith('.md') && !filename.startsWith('.')
        })
      } catch {
        // Nothing to watch yet: a project that has never filed a ticket has no folder, and Toucan
        // does not create one in someone's checkout just to look at it. Unclaimed, so the next
        // listing tries again - which is what the board's Refresh is for once the folder appears.
        claimed.delete(projectPath)
      }
    },
    subscribe: (owner) => watches.subscribe(owner),
    disconnectOwner: (owner) => {
      watches.disconnectOwner(owner)
      // Nobody left to tell. Holding OS watch handles for a window that is gone (or for a project
      // since removed from the workspace) leaks them for the life of the process; the next window
      // re-watches on its first listing.
      if (!watches.hasOwners()) {
        watches.closeAll()
        claimed.clear()
      }
    },
    shutdown: () => {
      stopped = true
      watches.shutdown()
      claimed.clear()
    }
  }
}

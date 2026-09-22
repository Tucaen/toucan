import { TICKET_CHANNELS } from '../shared/ipc-channels'
import { createWatchedDirectories, type WatchDirectory } from './watched-directories'
import type { WebContentsOwner } from './web-contents-owner'

/** A renderer watching ticket folders; the payload is the project path whose folder changed. */
export type TicketChangeOwner = WebContentsOwner<string>

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
  /**
   * A project's tickets folder settled. The board hears about it through the renderer event
   * beside this; main's own reader of the same change is `ticket-steering.ts`, which re-lists the
   * folder and tells whichever session wrote a file the board cannot read as a ticket.
   */
  onChanged?(projectPath: string): void
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
 * unwatched and is retried on its next listing.
 *
 * The folder is resolved on every call rather than once per project, because it is a per-project
 * setting the user can change: a board still watching the folder a project used to keep tickets in
 * would go quiet exactly when the new one starts changing.
 */
export function createTicketChangeWatcher(options: TicketChangeWatcherOptions): TicketChangeWatcher {
  const watches = createWatchedDirectories({
    channel: TICKET_CHANNELS.changed,
    debounceMs: options.debounceMs,
    watchDirectory: options.watchDirectory,
    ...(options.onChanged ? { onPublish: options.onChanged } : {})
  })
  /** The folder each project is watched on, so a resolution that did not change costs nothing. */
  const watched = new Map<string, string>()
  /** Held across the await, so two concurrent lists cannot open two watchers on one project. */
  const resolving = new Set<string>()
  let stopped = false

  return {
    watchProject: async (projectPath) => {
      if (stopped || resolving.has(projectPath)) return
      resolving.add(projectPath)
      try {
        const folder = await options.directoryFor(projectPath)
        if (stopped || watched.get(projectPath) === folder) return
        try {
          watches.open(projectPath, {
            directory: folder,
            // Only Markdown matters; durable-write temporaries are dotfiles.
            matches: (filename) => filename.toLowerCase().endsWith('.md') && !filename.startsWith('.')
          })
          watched.set(projectPath, folder)
        } catch {
          // Nothing to watch yet: a project that has never filed a ticket has no folder, and Toucan
          // does not create one in someone's checkout just to look at it. A watcher on the folder
          // the project used to use is dropped rather than left publishing changes nobody reads,
          // and the next listing tries again - which is what Refresh is for once it appears.
          watches.close(projectPath)
          watched.delete(projectPath)
        }
      } catch {
        // The folder could not even be decided; retried on this project's next listing.
      } finally {
        resolving.delete(projectPath)
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
        watched.clear()
      }
    },
    shutdown: () => {
      stopped = true
      watches.shutdown()
      watched.clear()
    }
  }
}

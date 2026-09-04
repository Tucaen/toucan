import type { TicketSourceListResult } from '../shared/ticket-source'
import type { TicketLibrary } from './ticket-library'
import type { TicketChangeOwner, TicketChangeWatcher } from './ticket-watcher'

interface TicketIpcRegistrar {
  handle(channel: string, listener: (event: { sender: TicketChangeOwner }, ...args: unknown[]) => unknown): void
}

const EMPTY: TicketSourceListResult = { cards: [], diagnostics: [] }

/**
 * The renderer's only route to a project's ticket files. Listing a project is also what subscribes
 * the window to that project's folder: a board that can read the tickets must find out when they
 * change, and tying the two together removes the failure mode where one happened without the other.
 *
 * `reveal` is injected rather than imported so this module stays free of Electron, exactly as
 * `brain-dump-ipc.ts` is.
 */
export function registerTicketIpc(
  ipc: TicketIpcRegistrar,
  library: TicketLibrary,
  changes: TicketChangeWatcher,
  reveal: (path: string) => void
): void {
  ipc.handle('tickets:list', async (event, projectPath: unknown) => {
    if (typeof projectPath !== 'string' || !projectPath) return EMPTY
    changes.subscribe(event.sender)
    void changes.watchProject(projectPath)
    try {
      return await library.list(projectPath)
    } catch (error) {
      // A folder that cannot be read at all is one diagnostic row, not a board that fails to open.
      return {
        cards: [],
        diagnostics: [{ path: projectPath, code: 'unreadable-folder', message: (error as Error).message }]
      }
    }
  })

  ipc.handle('tickets:set-status', (_event, projectPath: unknown, slug: unknown, status: unknown) =>
    typeof projectPath === 'string' && typeof slug === 'string' && typeof status === 'string'
      ? library.setStatus(projectPath, slug, status)
      : { ok: false, code: 'invalid-request', message: 'Project, ticket and status are required.' }
  )

  ipc.handle('tickets:reveal', async (_event, projectPath: unknown, slug: unknown) => {
    if (typeof projectPath !== 'string' || typeof slug !== 'string') return
    const path = await library.pathFor(projectPath, slug)
    if (path) reveal(path)
  })
}

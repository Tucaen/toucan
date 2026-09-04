import type { TicketFilesApi, TicketSource } from '../../shared/ticket-source'
import { TICKET_FILES_SOURCE_ID } from '../../shared/ticket-source'

/**
 * The always-on source: the Markdown files in the project's own checkout, reached through the
 * preload bridge. It is a thin adapter on purpose - everything that decides what a ticket file is
 * lives in `shared/tickets.ts` and `main/ticket-library.ts`, so this is only where the seam meets
 * the bridge, and the board above it cannot tell a file from an issue.
 */
export function createTicketFileSource(api: TicketFilesApi): TicketSource {
  return {
    id: TICKET_FILES_SOURCE_ID,
    label: 'Files',
    list: (projectPath) => api.list(projectPath),
    setStatus: (projectPath, cardId, status) => api.setStatus(projectPath, cardId, status),
    openExternal: (projectPath, cardId) => api.revealInFolder(projectPath, cardId),
    onChange: (callback) => api.onChange(callback)
  }
}

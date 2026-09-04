import type { TicketFilesApi, TicketSource } from '../../shared/ticket-source'
import { TICKET_FILES_SOURCE_ID } from '../../shared/ticket-source'

/**
 * The always-on source: the Markdown files in the project's own checkout, reached through the
 * preload bridge. It is a thin adapter on purpose - everything that decides what a ticket file is
 * lives in `shared/tickets.ts` and `main/ticket-library.ts`, so this is only where the seam meets
 * the bridge, and the board above it cannot tell a file from an issue.
 */
/** What a deletion costs here, which is entirely whether the checkout's history would keep it. */
const RECOVERABLE = 'The ticket file is removed from the folder. Git history keeps it, so it can be recovered.'
const FINAL = 'The ticket file is removed from the folder. This project is not a git checkout, so this is final.'

export function createTicketFileSource(api: TicketFilesApi): TicketSource {
  return {
    id: TICKET_FILES_SOURCE_ID,
    label: 'Files',
    list: (projectPath) => api.list(projectPath),
    setStatus: (projectPath, cardId, status) => api.setStatus(projectPath, cardId, status),
    remove: (projectPath, cardId) => api.remove(projectPath, cardId),
    // The board is told what deleting costs, never what git is - and a probe that fails is read as
    // "no history to fall back on", because the cautious sentence is the one that stays true.
    removalNote: (projectPath) =>
      api
        .isGitRepository(projectPath)
        .then((repository) => (repository ? RECOVERABLE : FINAL))
        .catch(() => FINAL),
    openExternal: (projectPath, cardId) => api.revealInFolder(projectPath, cardId),
    onChange: (callback) => api.onChange(callback)
  }
}

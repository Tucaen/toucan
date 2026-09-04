import type { TicketGithubListResult, TicketSourceAvailability } from '../shared/ticket-source'
import type { GithubIssueReader } from './github-issues'

interface GithubIssuesIpcRegistrar {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void
}

const NO_PROJECT = { available: false as const, reason: 'No project is selected.' }

/**
 * The renderer's only route to a project's GitHub issues. Two channels rather than one because the
 * board asks two different questions: *may I offer this source at all* on every project switch,
 * and *what are its issues* only once the user has switched it on. Kept apart from `ticket-ipc.ts`
 * because nothing is shared but the seam - GitHub has no folder to watch and nothing to write.
 */
export function registerGithubIssuesIpc(ipc: GithubIssuesIpcRegistrar, reader: GithubIssueReader): void {
  ipc.handle('github-issues:availability', async (_event, projectPath: unknown): Promise<TicketSourceAvailability> =>
    typeof projectPath === 'string' && projectPath ? reader.availability(projectPath) : NO_PROJECT
  )

  ipc.handle('github-issues:list', async (_event, projectPath: unknown): Promise<TicketGithubListResult> => {
    if (typeof projectPath !== 'string' || !projectPath) return NO_PROJECT
    try {
      return await reader.list(projectPath)
    } catch (error) {
      // The reader promises not to throw; if it ever does, the board still gets a reason.
      return { available: false, reason: (error as Error).message }
    }
  })
}

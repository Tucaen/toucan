import type { TicketGithubListResult, TicketSourceAvailability } from '../shared/ticket-source'
import { errorMessage } from '../shared/text'
import type { GithubIssueReader } from './github-issues'
import type { IpcRegistrar } from './ipc-registrar'
import { GITHUB_ISSUES_CHANNELS } from '../shared/ipc-channels'
import type { WorkspaceContainment } from './workspace-containment'

const NO_PROJECT = { available: false as const, reason: 'No project is selected.' }

/**
 * The renderer's only route to a project's GitHub issues. Two channels rather than one because the
 * board asks two different questions: *may I offer this source at all* on every project switch,
 * and *what are its issues* only once the user has switched it on. Kept apart from `ticket-ipc.ts`
 * because nothing is shared but the seam - GitHub has no folder to watch and nothing to write.
 */
export function registerGithubIssuesIpc(ipc: IpcRegistrar, reader: GithubIssueReader, containment: Pick<WorkspaceContainment, 'contains'>): void {
  ipc.handle(
    GITHUB_ISSUES_CHANNELS.availability,
    async (_event, projectPath: unknown): Promise<TicketSourceAvailability> =>
      typeof projectPath === 'string' && await containment.contains(projectPath) ? reader.availability(projectPath) : NO_PROJECT
  )

  ipc.handle(GITHUB_ISSUES_CHANNELS.list, async (_event, projectPath: unknown): Promise<TicketGithubListResult> => {
    if (typeof projectPath !== 'string' || !(await containment.contains(projectPath))) return NO_PROJECT
    try {
      return await reader.list(projectPath)
    } catch (error) {
      // The reader promises not to throw; if it ever does, the board still gets a reason.
      return { available: false, reason: errorMessage(error) }
    }
  })
}

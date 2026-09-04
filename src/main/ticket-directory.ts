import { resolve } from 'node:path'
import type { WorkspaceProject } from '../shared/terminal'
import { ticketsDirectoryOrDefault } from '../shared/tickets'

/**
 * Where a project keeps its tickets. A decision rather than a lookup, which is why it does not
 * live in `index.ts`: the default, the per-project override, and the refusal to follow an override
 * that points outside the checkout are all rules someone has to be able to find and test. Those
 * rules themselves are `ticketsDirectoryOrDefault` in `shared/tickets.ts`, because the renderer
 * answers the same question for the board's live session cards.
 *
 * A project Toucan does not know is still answerable - the board may be pointed at a path before
 * the snapshot catches up, and the default folder is the right answer for it.
 */
export function ticketsDirectoryFor(projectPath: string, projects: readonly WorkspaceProject[]): string {
  const project =
    projects.find((candidate) => candidate.path === projectPath) ??
    // Windows paths differ only in case surprisingly often (a drive letter typed either way).
    projects.find((candidate) => candidate.path.toLowerCase() === projectPath.toLowerCase())
  return resolve(projectPath, ticketsDirectoryOrDefault(project?.ticketsDirectory))
}

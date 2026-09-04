import { resolve } from 'node:path'
import type { WorkspaceProject } from '../shared/terminal'
import { DEFAULT_TICKETS_DIRECTORY, isTicketsDirectory } from '../shared/tickets'

/**
 * Where a project keeps its tickets. A decision rather than a lookup, which is why it does not
 * live in `index.ts`: the default, the per-project override, and the refusal to follow an override
 * that points outside the checkout are all rules someone has to be able to find and test.
 *
 * A project Toucan does not know is still answerable - the board may be pointed at a path before
 * the snapshot catches up, and the default folder is the right answer for it.
 */
export function ticketsDirectoryFor(projectPath: string, projects: readonly WorkspaceProject[]): string {
  const project =
    projects.find((candidate) => candidate.path === projectPath) ??
    // Windows paths differ only in case surprisingly often (a drive letter typed either way).
    projects.find((candidate) => candidate.path.toLowerCase() === projectPath.toLowerCase())
  const configured = project?.ticketsDirectory
  // An override that escapes the checkout is ignored rather than obeyed: a hand-edited snapshot
  // must not be able to aim Toucan's ticket reads and writes at an arbitrary folder.
  const relative = configured && isTicketsDirectory(configured) ? configured.trim() : DEFAULT_TICKETS_DIRECTORY
  return resolve(projectPath, relative)
}

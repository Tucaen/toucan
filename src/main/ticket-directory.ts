import { resolve } from 'node:path'
import type { WorkspaceProject } from '../shared/terminal'
import { ticketsDirectoryOrDefault } from '../shared/tickets'

/**
 * The workspace entry for a checkout, if Toucan knows it. Windows paths differ only in case
 * surprisingly often (a drive letter typed either way), so an exact match is preferred and a
 * case-insensitive one accepted.
 */
export function projectFor(projectPath: string, projects: readonly WorkspaceProject[]): WorkspaceProject | undefined {
  return (
    projects.find((candidate) => candidate.path === projectPath) ??
    projects.find((candidate) => candidate.path.toLowerCase() === projectPath.toLowerCase())
  )
}

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
  return resolve(projectPath, ticketsRelativeDirectoryFor(projectPath, projects))
}

/**
 * The same answer before it is resolved against the checkout. Prose about where tickets live -
 * the board's primer, the scaffolded skill - names the folder the way the project writes it, so
 * the relative form is the one those callers need, and it comes from here rather than from a
 * second reading of the project's setting.
 */
export function ticketsRelativeDirectoryFor(projectPath: string, projects: readonly WorkspaceProject[]): string {
  return ticketsDirectoryOrDefault(projectFor(projectPath, projects)?.ticketsDirectory)
}

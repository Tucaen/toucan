/**
 * The scratch folder (#3): where a session saves a file meant for the human - a screenshot, an
 * image, a generated report - so the link to it opens with one click.
 *
 * It lives in the project's *main* checkout, never a ticket worktree, because cleanup removes the
 * worktree after the merge and the link in the transcript has to outlive it. It is inside the
 * project because that is what the workspace gate admits: a file in the system temp folder is
 * refused on the desktop and on the phone alike, and the gate is deliberately not widened.
 *
 * The dot-name is Toucan's own (a project's `.scratch` is not ours to claim), and one folder, not a
 * pattern, so the single ignore line `SCRATCH_EXCLUDE_PATTERN` covers all of it.
 */
export const SCRATCH_DIRECTORY_NAME = '.toucan-scratch'

/**
 * The line written to the repository's `info/exclude`. Anchored, so only the top-level folder is
 * ignored and a project's own nested folder of the same name is left alone.
 */
export const SCRATCH_EXCLUDE_PATTERN = `/${SCRATCH_DIRECTORY_NAME}/`

/**
 * A session's own subfolder of the scratch folder, in the platform's own path form. The folder is
 * shared by every session of the project, and a generic file name in it (or in the system temp
 * folder) is a collision waiting for the next session that picks the same one - a stale plan from
 * another orchestration was once read as the current orchestration's. `name` carries the session's
 * identity (`orchestrator-<node id>`, `ticket-<scope>-<slug>`), so two sessions cannot share a path.
 */
export function sessionScratchFolder(scratchPath: string, name: string): string {
  const separator = scratchPath.includes('\\') && !scratchPath.includes('/') ? '\\' : '/'
  return `${scratchPath.replace(/[\\/]+$/, '')}${separator}${name}`
}

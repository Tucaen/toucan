/**
 * Most projects are started by one or more terminal commands ("API (watch)", "Web"), so a project
 * carries a list of them as `WorkspaceProject.runCommands`. Every rule about that list lives here:
 * the renderer's settings dialog edits drafts through these functions and main validates stored
 * entries with the same guard, so the two sides of the privilege seam cannot drift.
 *
 * Array order is display order, exactly as it is for the sidebar's own project list - there is no
 * `order` field to keep in step, and reordering is `moveRunCommand` rewriting the array.
 */
export interface ProjectRunCommand {
  /**
   * Stable across edits and reorders, so a dialog row keeps its React identity while it is typed
   * into and a menu entry keeps naming the same command.
   */
  id: string
  /** What the user sees in the settings list and, later, in the project's Run menu. */
  name: string
  /** The shell command line, run in the project checkout. */
  command: string
}

/** What main accepts out of a persisted snapshot: exactly three strings and nothing inferred. */
export function isProjectRunCommand(value: unknown): value is ProjectRunCommand {
  if (!value || typeof value !== 'object') return false
  const entry = value as Partial<ProjectRunCommand>
  return typeof entry.id === 'string' && typeof entry.name === 'string' && typeof entry.command === 'string'
}

/**
 * What a draft list is saved as: both fields trimmed, and rows the user never filled in dropped,
 * so clicking Add and changing one's mind costs nothing. A row where only *one* field is empty is
 * deliberately kept - `runCommandsIncomplete` refuses the save instead, because silently
 * discarding half-typed work is worse than saying it is unfinished.
 */
export function normalizeRunCommands(drafts: readonly ProjectRunCommand[]): ProjectRunCommand[] {
  return drafts
    .map((entry) => ({ ...entry, name: entry.name.trim(), command: entry.command.trim() }))
    .filter((entry) => entry.name !== '' || entry.command !== '')
}

/** Whether a draft list still holds a row with a name but no command line, or the reverse. */
export function runCommandsIncomplete(drafts: readonly ProjectRunCommand[]): boolean {
  return normalizeRunCommands(drafts).some((entry) => entry.name === '' || entry.command === '')
}

/**
 * Moves one row `delta` places. The ends are walls rather than a wrap, and an out-of-range request
 * returns the very same list, so a caller can treat an unchanged identity as "nothing to do".
 */
export function moveRunCommand(
  list: readonly ProjectRunCommand[],
  index: number,
  delta: number
): readonly ProjectRunCommand[] {
  const target = index + delta
  if (index < 0 || index >= list.length || target < 0 || target >= list.length) return list
  const next = [...list]
  const [moved] = next.splice(index, 1)
  next.splice(target, 0, moved)
  return next
}

/**
 * Most projects are started by one or more terminal commands ("API (watch)", "Web"), so a project
 * carries a list of them as `WorkspaceProject.runCommands`. Every rule about that list lives here -
 * the renderer's settings dialog edits drafts through these functions and main validates stored
 * entries with the same guard, so the two sides of the privilege seam cannot drift - and with them
 * `terminalRunInput`, the one rule for handing any command line to a visible terminal, which the
 * worktree setup command shares.
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

/**
 * What main accepts out of a persisted snapshot: exactly three strings and nothing inferred.
 *
 * Deliberately looser than the dialog, which refuses a half-typed row: this guard answers "is this
 * the right *shape* to hand back across the privilege seam", not "would the user have been allowed
 * to type it". A hand-edited snapshot naming an empty command is therefore loaded rather than
 * discarded - it costs nothing, and refusing it would throw away the whole workspace over one
 * blank field.
 */
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
 * The commands a project's Run menu offers. The stored list is deliberately looser than the dialog
 * - `isProjectRunCommand` loads a hand-edited snapshot naming an empty command rather than throwing
 * the workspace away - so the menu filters here instead: a row with no name has nothing to show and
 * a row with no command line has nothing to run, and either way spawning a terminal for it would
 * only produce a shell that types a bare newline. An empty result is what "this project shows no
 * Run section" means, so a project with no commands and a project whose only command is blank read
 * the same way.
 */
export function runnableCommands(commands: readonly ProjectRunCommand[] | undefined): ProjectRunCommand[] {
  return (commands ?? []).filter((entry) => entry.name.trim() !== '' && entry.command.trim() !== '')
}

/**
 * What is written into a freshly started terminal to run `command`: the line, then the Enter the
 * user would have pressed. Shared by the worktree setup command and the project's Run menu, because
 * both are the same gesture - hand a visible terminal a command line so failures, prompts and
 * long-running processes can be watched and interrupted. A command that is only whitespace yields
 * `''`, so a caller can treat the empty string as "there is nothing to run".
 */
export function terminalRunInput(command: string): string {
  const trimmed = command.trim()
  return trimmed === '' ? '' : `${trimmed}\r`
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

/**
 * One entry the composer's `@` picker can offer. Paths are relative to the index's root and
 * always use forward slashes, so a Windows index and the reference the agent finally receives
 * read the same on both sides of the IPC boundary.
 */
export interface WorkspaceFileEntry {
  path: string
  directory: boolean
}

/**
 * A bounded snapshot of the files under one working directory. `truncated` and `gitignored` are
 * part of the contract rather than diagnostics: a picker that silently hides half a repository,
 * or silently stops honouring `.gitignore` when a directory is not a git checkout, is lying to
 * the reader about what the agent can be pointed at.
 */
export interface WorkspaceFileIndex {
  /** The directory the paths are relative to - a node's resolved `workingDirectory`. */
  root: string
  entries: WorkspaceFileEntry[]
  /** The walk hit `WORKSPACE_FILE_INDEX_LIMIT` and stopped; the picker says so. */
  truncated: boolean
  /** Whether `.gitignore` (and git's other exclude sources) shaped this list. */
  gitignored: boolean
}

/**
 * How many files one directory may contribute. Large enough for any repository a person works
 * in, small enough that the list crosses IPC and is ranked in the renderer without a stutter.
 */
export const WORKSPACE_FILE_INDEX_LIMIT = 20_000

export const emptyWorkspaceFileIndex = (root: string): WorkspaceFileIndex => ({
  root,
  entries: [],
  truncated: false,
  gitignored: false
})

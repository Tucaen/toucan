/**
 * Which branch a checkout is on, as the renderer needs to read it: a repository that cannot be
 * inspected, a path that is not a repository at all, and a detached HEAD are three different
 * answers, and none of them may render as "on some branch, all fine".
 */
export interface GitBranchState {
  /** False for a missing path, a non-repository, or a git that would not run. */
  isRepository: boolean
  /** Absent while HEAD is detached. */
  branch?: string
  /** The short commit HEAD points at, reported only when there is no branch to name. */
  detachedHead?: string
}

/**
 * What a branch indicator shows for the checkout at `directory`; `undefined` means there is
 * nothing worth a row at all. The title names the directory because a node may be running in a
 * worktree rather than the project itself, and then "on main" alone would be a half-truth.
 */
export function describeGitBranch(
  state: GitBranchState | null,
  directory: string
): { label: string; title: string } | undefined {
  if (!state?.isRepository) return undefined
  if (state.branch) return { label: state.branch, title: `${directory} is on ${state.branch}` }
  if (state.detachedHead) {
    return {
      label: `detached at ${state.detachedHead}`,
      title: `${directory} has a detached HEAD at ${state.detachedHead}`
    }
  }
  return { label: 'detached', title: `${directory} has a detached HEAD` }
}

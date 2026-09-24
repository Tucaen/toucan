/**
 * Which branch a checkout is on, as the renderer needs to read it: a repository that cannot be
 * inspected, a path that is not a repository at all, and a detached HEAD are three different
 * answers, and none of them may render as "on some branch, all fine".
 */
/** Where a checkout's `HEAD` points: the full commit, and the branch unless `HEAD` is detached. */
export interface GitHeadState {
  commit: string
  branch?: string
}

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

/**
 * One local branch as the switcher lists it. `worktreePath` is where git already has the branch
 * checked out - the project checkout itself for the current branch, a worktree for any other -
 * and git refuses to check such a branch out a second time, so the switcher greys it out rather
 * than letting the user discover that from an error.
 */
export interface GitLocalBranch {
  name: string
  current: boolean
  worktreePath?: string
}

export interface GitBranchListResult {
  ok: boolean
  branches: GitLocalBranch[]
  message?: string
}

export interface GitCheckoutRequest {
  path: string
  branch: string
}

export interface GitCheckoutResult {
  ok: boolean
  /** Git's own words when the checkout was refused - most often uncommitted changes in the way. */
  message?: string
}

/** The `--format` handed to `git branch`: name, HEAD marker, and worktree path, tab-separated. */
export const LOCAL_BRANCH_FORMAT = '%(refname:short)%09%(HEAD)%09%(worktreepath)'

/** Parses the output of `git branch --format=LOCAL_BRANCH_FORMAT`; the current branch sorts first. */
export function parseLocalBranches(stdout: string): GitLocalBranch[] {
  const branches: GitLocalBranch[] = []
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue
    const [name, head = '', worktreePath = ''] = line.split('\t')
    // A detached worktree shows up as "(HEAD detached at …)"; it is not a branch anyone can pick.
    if (!name || name.startsWith('(')) continue
    branches.push({
      name,
      current: head.trim() === '*',
      ...(worktreePath.trim() ? { worktreePath: worktreePath.trim() } : {})
    })
  }
  return branches.sort((a, b) => Number(b.current) - Number(a.current) || a.name.localeCompare(b.name))
}

/**
 * Why a branch cannot be picked right now, or `undefined` when it can. Switching the project
 * checkout under a session that is mid-turn swaps the files it is editing, so that is refused
 * outright rather than warned about - the same fail-closed instinct worktree removal has.
 */
export function describeBranchChoiceBlocker(
  branch: GitLocalBranch,
  context: { workingSessions: number }
): string | undefined {
  if (branch.current) return 'Already checked out'
  if (branch.worktreePath) return `Checked out in ${branch.worktreePath}`
  if (context.workingSessions > 0) {
    return context.workingSessions === 1
      ? '1 session is working in this checkout; wait for it to finish'
      : `${context.workingSessions} sessions are working in this checkout; wait for them to finish`
  }
  return undefined
}

/**
 * Read-only Git provenance for one reported crew worktree.
 *
 * FirstMate owns worktree allocation and its mandatory spawn guard; ADE never allocates a worktree of
 * its own. But before ADE supervises, validates, or counts a reported worktree as progress, it needs
 * independent evidence that the worktree really belongs to the external checkout the task was pinned
 * to. A path that merely exists and differs from the checkout is not enough: it can still be a worktree
 * cut from an entirely different repository, or the user's own primary checkout.
 *
 * The proof is Git's own `git-common-dir`. Every working tree linked to one repository shares a single
 * common directory, so a worktree whose common directory is not the pinned checkout's belongs to a
 * foreign repository. And only a primary working tree has its `git-dir` equal to that common directory,
 * so a reported worktree with `git-dir === git-common-dir` is a primary checkout rather than a
 * disposable crew worktree.
 *
 * The facts are gathered read-only in the WSL host (see `WSL_LIFECYCLE_READ_SCRIPT`, which only ever
 * runs `git rev-parse`); the verdict is decided here so it can be tested against real Git worktrees
 * without invoking WSL.
 */

/** Where Git resolves a working tree: its own git dir, and the repository-wide common dir. */
export interface FirstMateGitIdentity {
  gitDir: string
  commonDir: string
}

/** The reported worktree's Git identity, or the reason ADE could not read it. */
export type FirstMateWorktreeProbe = FirstMateGitIdentity | { error: string }

/** The pinned checkout's common directory, or the reason ADE could not read it. */
export type FirstMateCheckoutProbe = { commonDir: string } | { error: string }

export interface FirstMateWorktreeProvenance {
  worktree: FirstMateWorktreeProbe
  checkout: FirstMateCheckoutProbe
}

function probeFailed<T extends object>(probe: T | { error: string }): probe is { error: string } {
  return 'error' in probe
}

/**
 * Git may report either a Windows-mount path or a native Linux path; on the mounts ADE targets both
 * compare case-insensitively, and a trailing separator is never significant.
 */
function normalizeGitPath(path: string): string {
  return path.trim().replace(/[\\/]+$/, '').toLocaleLowerCase()
}

/**
 * The integration failure a reported crew worktree presents, or `undefined` when its provenance proves
 * it is a disposable worktree of the pinned checkout. A foreign-repository worktree and the primary
 * checkout are refused with distinct, actionable messages; an unreadable probe is refused too, because
 * ADE cannot supervise work it cannot prove belongs to the pinned checkout.
 */
export function firstMateWorktreeProvenanceProblem(
  taskId: string,
  worktreePath: string,
  provenance: FirstMateWorktreeProvenance
): string | undefined {
  const { worktree, checkout } = provenance
  if (probeFailed(worktree)) {
    return `Task ${taskId} reported crew worktree ${JSON.stringify(worktreePath)} whose Git provenance ADE could not `
      + `read (${worktree.error}); its work is not supervised until the worktree proves it belongs to the pinned checkout.`
  }
  if (probeFailed(checkout)) {
    return `Task ${taskId} cannot prove its crew worktree provenance because ADE could not read the pinned checkout's `
      + `Git identity (${checkout.error}).`
  }
  if (normalizeGitPath(worktree.commonDir) !== normalizeGitPath(checkout.commonDir)) {
    return `Task ${taskId} reported crew worktree ${JSON.stringify(worktreePath)} from a foreign repository: its Git `
      + `common directory ${JSON.stringify(worktree.commonDir)} is not the pinned checkout's `
      + `${JSON.stringify(checkout.commonDir)}, so its work is not supervised, validated, or counted as progress.`
  }
  if (normalizeGitPath(worktree.gitDir) === normalizeGitPath(worktree.commonDir)) {
    return `Task ${taskId} reported the user's primary checkout ${JSON.stringify(worktreePath)} as its crew worktree; `
      + 'ADE refuses to supervise crew work against the primary working tree.'
  }
  return undefined
}

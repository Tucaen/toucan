import type { WorktreeRemovalBlocker } from '../../shared/worktree'
import { isForcibleBlocker } from '../../shared/worktree'

export type WorktreeRemovalDecision =
  /** Nothing can proceed: something must change on the canvas or in the repository first. */
  | 'blocked'
  /** Only unsaved work stands in the way; the user may knowingly discard it. */
  | 'confirm'
  /** Provably nothing unique lives here. */
  | 'ready'

export interface WorktreeRemovalPlan {
  decision: WorktreeRemovalDecision
  /** Blockers no confirmation can clear. */
  hard: WorktreeRemovalBlocker[]
  /** Blockers a deliberate confirmation may override, each naming what would be lost. */
  forcible: WorktreeRemovalBlocker[]
}

/**
 * Folds the renderer's own evidence (how many nodes still run here) together with the git
 * evidence from the main process into one verdict. Attachment is a hard blocker: tearing a
 * directory out from under a live agent or shell is never something a dialog should offer.
 */
export function planWorktreeRemoval(
  attachedNodeCount: number,
  blockers: WorktreeRemovalBlocker[]
): WorktreeRemovalPlan {
  const all: WorktreeRemovalBlocker[] = [
    ...(attachedNodeCount > 0 ? [{ kind: 'attached-nodes' as const, count: attachedNodeCount }] : []),
    ...blockers.filter((blocker) => blocker.kind !== 'attached-nodes')
  ]
  const hard = all.filter((blocker) => !isForcibleBlocker(blocker))
  const forcible = all.filter(isForcibleBlocker)

  return {
    decision: hard.length > 0 ? 'blocked' : forcible.length > 0 ? 'confirm' : 'ready',
    hard,
    forcible
  }
}

/**
 * What a forced removal actually costs. Commits and the branch always survive - only the
 * directory goes - so the warning names uncommitted and untracked work specifically rather
 * than claiming the whole branch is at risk.
 */
export function describeForcedRemovalCost(forcible: WorktreeRemovalBlocker[]): string {
  const losesFiles = forcible.some(
    (blocker) => blocker.kind === 'uncommitted-changes' || blocker.kind === 'untracked-files'
  )
  const keepsCommits = forcible.some(
    (blocker) => blocker.kind === 'unpublished-commits' || blocker.kind === 'stashed-changes'
  )

  if (losesFiles && keepsCommits) {
    return 'Removing the directory deletes the uncommitted and untracked files for good. The branch, its commits, and its stash entries stay in the repository.'
  }
  if (losesFiles) {
    return 'Removing the directory deletes the uncommitted and untracked files for good. The branch and its commits stay in the repository.'
  }
  return 'The branch, its commits, and its stash entries stay in the repository; only the working directory is removed.'
}

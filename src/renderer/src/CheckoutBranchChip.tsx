import { memo } from 'react'
import { GitBranch } from 'lucide-react'
import { describeGitBranch, type GitBranchState } from '../../shared/git-branch'

/**
 * The branch of the checkout a node actually runs in, shown at the right end of the chat's status
 * bar. Every decision it renders was already made by `describeGitBranch`, so this file is markup
 * only - including the decision to render nothing at all when the directory is not a git
 * repository, which is why the caller may not reserve space for it unconditionally.
 */
function CheckoutBranchChip({
  state,
  directory
}: {
  state: GitBranchState | null
  directory: string
}): JSX.Element | null {
  const branch = describeGitBranch(state, directory)
  if (!branch) return null

  return (
    <span className="session-checkout-branch" data-detached={state?.branch ? undefined : 'true'} title={branch.title}>
      <span className="worktree-glyph" aria-hidden="true">
        <GitBranch />
      </span>
      {branch.label}
    </span>
  )
}

export default memo(CheckoutBranchChip)

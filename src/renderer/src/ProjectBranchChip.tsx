import { memo } from 'react'
import { ChevronDown, GitBranch } from 'lucide-react'
import { describeGitBranch } from '../../shared/git-branch'
import { useCheckoutBranch } from './use-checkout-branch'

/**
 * The branch of the project checkout, in the sidebar row, and the one place a branch is switched
 * from. It lives on the project rather than on a node deliberately: a node's own chip names the
 * checkout that node runs in, which for a worktree node is not the project's, and a click there
 * would read as "change this node's branch" - an operation Toucan does not offer.
 *
 * It renders nothing for a directory that is not a repository, so the row keeps its plain path.
 */
function ProjectBranchChip({
  directory,
  revision,
  onOpen
}: {
  directory: string
  /** Bumped by the workspace after it switched the branch itself, so the row updates at once. */
  revision: number
  /** Opens the switcher anchored to the chip's rectangle. */
  onOpen(anchor: DOMRect): void
}): JSX.Element | null {
  const state = useCheckoutBranch(directory, revision)
  const branch = describeGitBranch(state, directory)
  if (!branch) return null

  return (
    <button
      type="button"
      className="project-branch"
      data-detached={state?.branch ? undefined : 'true'}
      title={`${branch.title}\nClick to switch branch`}
      onClick={(event) => {
        event.stopPropagation()
        onOpen(event.currentTarget.getBoundingClientRect())
      }}
    >
      <span className="worktree-glyph" aria-hidden="true">
        <GitBranch />
      </span>
      <span className="project-branch-name">{branch.label}</span>
      <ChevronDown className="project-branch-caret" aria-hidden="true" />
    </button>
  )
}

export default memo(ProjectBranchChip)

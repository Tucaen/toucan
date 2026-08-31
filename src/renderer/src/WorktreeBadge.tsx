import type { TerminalNodeData } from './canvas-workspace'

/**
 * Which tree a session is editing is the single most consequential fact about it once
 * worktrees exist, so every session node carries this in its header - including the
 * detached case, which must never read as "running in the project checkout, all fine".
 */
export default function WorktreeBadge({ data }: { data: TerminalNodeData }): JSX.Element | null {
  if (data.detachedFromWorktree) {
    return (
      <span
        className="node-worktree"
        data-detached="true"
        title="This node's worktree is no longer in the workspace. Reopening it will run in the project checkout instead."
      >
        detached
      </span>
    )
  }
  if (!data.worktreeBranch) {
    // A session that made a worktree without moving into it. The badge says "working in",
    // never "runs in", because the node's own directory is still the project checkout.
    if (!data.activeWorktreeBranch) return null
    return (
      <span
        className="node-worktree"
        data-active="true"
        title={`Working in a worktree on ${data.activeWorktreeBranch}; this node still runs in ${data.workingDirectory}`}
      >
        <span className="worktree-glyph" aria-hidden="true">
          ⑂
        </span>
        {data.activeWorktreeBranch}
      </span>
    )
  }
  return (
    <span className="node-worktree" title={`Runs in ${data.workingDirectory}`}>
      <span className="worktree-glyph" aria-hidden="true">
        ⑂
      </span>
      {data.worktreeBranch}
    </span>
  )
}

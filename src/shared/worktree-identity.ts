import type { WorkspaceState } from './terminal'
import { normalizeWorktreePath, worktreePathKey } from './worktree'

/** First record wins, keeping its geometry and metadata; references follow the surviving id. */
export function normalizeWorkspaceWorktrees(state: WorkspaceState): WorkspaceState {
  const byProject = new Map<string, Map<string, string>>()
  const aliases = new Map<string, string>()
  const worktrees = state.worktrees.flatMap((worktree) => {
    const paths = byProject.get(worktree.projectId) ?? new Map<string, string>()
    byProject.set(worktree.projectId, paths)
    const key = worktreePathKey(worktree.path)
    const existing = paths.get(key)
    if (existing) {
      aliases.set(worktree.id, existing)
      return []
    }
    paths.set(key, worktree.id)
    return [{ ...worktree, path: normalizeWorktreePath(worktree.path) }]
  })
  const remap = <T extends { worktreeId?: string; activeWorktreeId?: string }>(node: T): T => ({
    ...node,
    ...(node.worktreeId && aliases.has(node.worktreeId) ? { worktreeId: aliases.get(node.worktreeId) } : {}),
    ...(node.activeWorktreeId && aliases.has(node.activeWorktreeId)
      ? { activeWorktreeId: aliases.get(node.activeWorktreeId) }
      : {})
  })
  return {
    ...state,
    worktrees,
    nodes: state.nodes.map(remap),
    ...(state.diffs ? { diffs: state.diffs.map(remap) } : {}),
    ...(state.recentlyClosedNodes ? { recentlyClosedNodes: state.recentlyClosedNodes.map(remap) } : {})
  }
}

/**
 * A worktree is a first-class workspace entity, not a side effect of opening a node:
 * it is created explicitly, nodes attach to it by id, and it is only ever removed
 * through an evidence-gated teardown. Nothing in this file talks to git; it is the
 * vocabulary and the pure path/branch rules that both processes agree on.
 */

export interface WorkspaceWorktree {
  id: string
  projectId: string
  /** The branch this worktree has checked out. Owned by the worktree for its whole life. */
  branch: string
  /** Absolute path of the worktree directory; the working directory of every attached node. */
  path: string
  /** The ref the branch was created from, kept so teardown can ask "is this merged back?". */
  baseRef: string
  createdAt: string
  position: { x: number; y: number }
  width: number
  height: number
}

export interface WorktreeCreateRequest {
  projectPath: string
  branch: string
  /** Ref to branch from; defaults to the project checkout's current HEAD. */
  baseRef?: string
}

export interface WorktreeCreateResult {
  ok: boolean
  message?: string
  worktree?: { path: string; branch: string; baseRef: string }
}

export interface WorktreeStatus {
  /** False once the directory is gone from disk; the record is then safe to drop. */
  exists: boolean
  branch?: string
  head?: string
  changedFiles: number
  untrackedFiles: number
  ahead: number
  behind: number
  /** True when the branch tracks a remote ref, so "ahead" means genuinely unpublished. */
  hasUpstream: boolean
  stashEntries: number
  message?: string
}

/**
 * Why a worktree cannot be torn down. `attached-nodes` is decided in the renderer (it
 * knows the canvas); every other blocker is git evidence gathered in the main process.
 * Missing evidence always produces a blocker rather than silent permission - the same
 * fail-closed instinct the terminal liveness verdict uses.
 */
export type WorktreeRemovalBlocker =
  | { kind: 'attached-nodes'; count: number }
  | { kind: 'not-a-worktree'; detail: string }
  | { kind: 'primary-worktree' }
  | { kind: 'uncommitted-changes'; files: number }
  | { kind: 'untracked-files'; files: number }
  | { kind: 'stashed-changes'; entries: number }
  | { kind: 'unpublished-commits'; commits: number }
  | { kind: 'inspection-failed'; detail: string }

export interface WorktreeRemoveRequest {
  projectPath: string
  path: string
  branch: string
  baseRef: string
  /**
   * Proceed despite forcible blockers. The branch and its commits always survive a removal;
   * only the directory goes, so forcing can lose uncommitted and untracked work and nothing else.
   */
  force?: boolean
}

export interface WorktreeRemoveResult {
  ok: boolean
  /** Non-empty when the removal was refused; empty and ok:false means it failed outright. */
  blockers: WorktreeRemovalBlocker[]
  message?: string
}

/**
 * Blockers that describe a broken or mistaken identity, rather than unsaved work. No
 * confirmation can clear these, because forcing past them would delete something ADE
 * has not proven it owns.
 */
export function isForcibleBlocker(blocker: WorktreeRemovalBlocker): boolean {
  return (
    blocker.kind !== 'attached-nodes' &&
    blocker.kind !== 'not-a-worktree' &&
    blocker.kind !== 'primary-worktree' &&
    blocker.kind !== 'inspection-failed'
  )
}

export function describeWorktreeBlocker(blocker: WorktreeRemovalBlocker): string {
  switch (blocker.kind) {
    case 'attached-nodes':
      return blocker.count === 1
        ? '1 node is still attached to this worktree'
        : `${blocker.count} nodes are still attached to this worktree`
    case 'not-a-worktree':
      return `This directory is not a worktree of the project checkout (${blocker.detail})`
    case 'primary-worktree':
      return 'This is the project primary checkout, not a worktree'
    case 'uncommitted-changes':
      return blocker.files === 1 ? '1 file has uncommitted changes' : `${blocker.files} files have uncommitted changes`
    case 'untracked-files':
      return blocker.files === 1
        ? '1 untracked file is not in any commit'
        : `${blocker.files} untracked files are not in any commit`
    case 'stashed-changes':
      return blocker.entries === 1
        ? '1 stash entry was made on this branch'
        : `${blocker.entries} stash entries were made on this branch`
    case 'unpublished-commits':
      return blocker.commits === 1
        ? '1 commit is neither merged into the base ref nor pushed'
        : `${blocker.commits} commits are neither merged into the base ref nor pushed`
    case 'inspection-failed':
      return `The worktree could not be inspected, so nothing was removed (${blocker.detail})`
  }
}

function splitPath(value: string): { parent: string; name: string; separator: string } {
  const separator = value.includes('\\') ? '\\' : '/'
  const trimmed = value.replace(/[\\/]+$/, '')
  const index = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'))
  return index < 0
    ? { parent: '', name: trimmed, separator }
    : { parent: trimmed.slice(0, index), name: trimmed.slice(index + 1), separator }
}

/** A branch name turned into one safe directory segment: `fix/login-2` becomes `fix-login-2`. */
export function worktreeDirectorySlug(branch: string): string {
  return branch
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
}

/**
 * Worktrees live beside the checkout, never inside it: a worktree nested under the project
 * would show up in the project's own file listings, searches, and agent context.
 */
export function deriveWorktreeDirectory(projectPath: string, branch: string): string {
  const { parent, name, separator } = splitPath(projectPath)
  const slug = worktreeDirectorySlug(branch)
  const container = `${name}-worktrees`
  return parent ? [parent, container, slug].join(separator) : [container, slug].join(separator)
}

const INVALID_BRANCH_PATTERN = /[\s~^:?*[\\]|\.\.|@\{/

/**
 * A cheap shape check so the renderer can reject obvious typos before any process starts.
 * `git check-ref-format` in the main process remains the authority.
 */
export function branchNameProblem(branch: string): string | null {
  const value = branch.trim()
  if (!value) return 'Enter a branch name'
  if (value !== branch) return 'Branch names cannot start or end with whitespace'
  if (INVALID_BRANCH_PATTERN.test(value)) return 'Branch names cannot contain whitespace or ~ ^ : ? * [ backslash .. @{'
  if (value.startsWith('/') || value.endsWith('/') || value.includes('//'))
    return 'Branch names cannot start, end, or double up on /'
  if (value.startsWith('-') || value.startsWith('.') || value.endsWith('.'))
    return 'Branch names cannot start with - or . or end with .'
  if (value.endsWith('.lock')) return 'Branch names cannot end with .lock'
  if (value === '@') return '@ is not a valid branch name'
  if (!worktreeDirectorySlug(value)) return 'Branch name has no usable characters'
  return null
}

/**
 * A worktree as git reports it, before ADE knows whether it has a record for it.
 * `isMain` marks the project checkout itself, which is never a worktree node.
 */
export interface WorktreeListEntry {
  path: string
  branch: string
  head: string
  isMain: boolean
}

/**
 * A note left by an agent that created a worktree for itself, so the node that asked for
 * the work can be linked to it. Written by the agent, never by ADE, so it is read as a
 * hint: an unmatched or stale claim only costs the association, never the worktree record.
 */
export interface WorktreeClaim {
  nodeId: string
  path: string
  branch: string
  claimedAt: string
}

/** A worktree git knows about that ADE has no record of yet. */
export interface DiscoveredWorktree {
  path: string
  branch: string
  baseRef: string
  /** The node that claimed authorship, when a claim matches this path. */
  claimedByNodeId?: string
}

/** Paths come back from git with forward slashes even on Windows, so compare on one shape. */
function comparablePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

/**
 * The difference between what git has and what the workspace records. Discovery only ever
 * adds: a worktree ADE does not know about becomes a node, while a record whose directory
 * has vanished is left alone for the evidence-gated teardown to handle. `baseRef` cannot be
 * recovered from git's worktree list, so discovered worktrees inherit the repository's
 * default branch - enough for teardown to ask "is this merged back?".
 */
export function discoverWorktrees(
  listed: readonly WorktreeListEntry[],
  known: readonly { path: string }[],
  claims: readonly WorktreeClaim[],
  defaultBranch: string
): DiscoveredWorktree[] {
  const recorded = new Set(known.map((worktree) => comparablePath(worktree.path)))
  const claimedBy = new Map(claims.map((claim) => [comparablePath(claim.path), claim.nodeId]))

  return listed
    .filter((entry) => !entry.isMain && entry.branch && !recorded.has(comparablePath(entry.path)))
    .map((entry) => ({
      path: entry.path,
      branch: entry.branch,
      baseRef: defaultBranch,
      claimedByNodeId: claimedBy.get(comparablePath(entry.path))
    }))
}

/**
 * `git worktree list --porcelain` emits one blank-line-separated block per worktree, the
 * first being the main checkout. A detached worktree has no branch and is skipped by
 * discovery rather than guessed at.
 */
export function parseWorktreeList(porcelain: string): WorktreeListEntry[] {
  const entries: WorktreeListEntry[] = []
  let current: Partial<WorktreeListEntry> = {}

  const flush = (): void => {
    if (current.path) {
      entries.push({
        path: current.path,
        branch: current.branch ?? '',
        head: current.head ?? '',
        isMain: entries.length === 0
      })
    }
    current = {}
  }

  for (const line of porcelain.split(/\r?\n/)) {
    if (!line.trim()) {
      flush()
      continue
    }
    const [key, ...rest] = line.split(' ')
    const value = rest.join(' ')
    if (key === 'worktree') current.path = value
    if (key === 'HEAD') current.head = value
    if (key === 'branch') current.branch = value.replace(/^refs\/heads\//, '')
  }
  flush()

  return entries
}

export interface WorktreeDiscoverRequest {
  projectPath: string
  /** Worktree paths the workspace already has records for. */
  known: string[]
}

export interface WorktreeDiscoverResult {
  worktrees: DiscoveredWorktree[]
  message?: string
}

/**
 * Claims live in the repository's common git directory, so every worktree of the same
 * repository reads and writes one file, and nothing lands in the user's global config.
 */
export const WORKTREE_CLAIMS_FILE = 'ade-worktree-claims.json'

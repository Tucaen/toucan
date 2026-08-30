import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  WorktreeClaim,
  WorktreeCreateRequest,
  WorktreeCreateResult,
  WorktreeDiscoverRequest,
  WorktreeDiscoverResult,
  WorktreeRemovalBlocker,
  WorktreeRemoveRequest,
  WorktreeRemoveResult,
  WorktreeStatus
} from '../shared/worktree'
import {
  WORKTREE_CLAIMS_FILE,
  branchNameProblem,
  deriveWorktreeDirectory,
  discoverWorktrees,
  isForcibleBlocker,
  parseWorktreeList
} from '../shared/worktree'
import { errorMessage } from '../shared/text'

/**
 * Claims are a hint written by an agent, so every failure mode - missing file, malformed
 * JSON, an entry of the wrong shape - costs the association and nothing else.
 */
function readClaims(path: string): WorktreeClaim[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (!Array.isArray(parsed)) return []
    return parsed.filter((claim): claim is WorktreeClaim => (
      Boolean(claim)
      && typeof claim === 'object'
      && typeof (claim as WorktreeClaim).nodeId === 'string'
      && typeof (claim as WorktreeClaim).path === 'string'
      && typeof (claim as WorktreeClaim).branch === 'string'
    ))
  } catch {
    return []
  }
}

export interface GitResult {
  code: number
  stdout: string
  stderr: string
}

export type GitRunner = (args: string[], cwd: string) => Promise<GitResult>

export interface WorktreeManagerOptions {
  runGit?: GitRunner
  pathExists?(path: string): boolean
}

export interface WorktreeStatusRequest {
  path: string
  branch: string
  baseRef: string
}

export interface WorktreeManager {
  create(request: WorktreeCreateRequest): Promise<WorktreeCreateResult>
  status(request: WorktreeStatusRequest): Promise<WorktreeStatus>
  /**
   * Refuses unless every blocker is either absent or explicitly forced. Removing a worktree
   * never deletes its branch, so the worst a forced removal can cost is uncommitted and
   * untracked files - which is exactly what the returned blockers name.
   */
  remove(request: WorktreeRemoveRequest): Promise<WorktreeRemoveResult>
  /**
   * Every worktree git knows about that the workspace has no record of, plus any authorship
   * claim an agent left behind. Read-only and best-effort: a repository that cannot be
   * inspected reports nothing rather than failing the caller.
   */
  discover(request: WorktreeDiscoverRequest): Promise<WorktreeDiscoverResult>
}

const GIT_MAX_BUFFER = 8 * 1024 * 1024

const runGitWithExecFile: GitRunner = (args, cwd) => new Promise<GitResult>((resolve) => {
  execFile('git', args, { cwd, windowsHide: true, maxBuffer: GIT_MAX_BUFFER }, (error, stdout, stderr) => {
    const code = error && typeof (error as { code?: unknown }).code === 'number'
      ? (error as { code: number }).code
      : error ? 1 : 0
    resolve({ code, stdout: stdout ?? '', stderr: stderr ?? '' })
  })
})

const emptyStatus = (message?: string): WorktreeStatus => ({
  exists: false,
  changedFiles: 0,
  untrackedFiles: 0,
  ahead: 0,
  behind: 0,
  hasUpstream: false,
  stashEntries: 0,
  ...(message ? { message } : {})
})

/** Git paths come back with forward slashes even on Windows, so compare on one shape. */
function normalizeGitPath(value: string): string {
  return value.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLocaleLowerCase()
}

function parsePorcelainStatus(stdout: string): Pick<WorktreeStatus, 'branch' | 'head' | 'changedFiles' | 'untrackedFiles' | 'ahead' | 'behind' | 'hasUpstream'> {
  let branch: string | undefined
  let head: string | undefined
  let changedFiles = 0
  let untrackedFiles = 0
  let ahead = 0
  let behind = 0
  let hasUpstream = false

  for (const line of stdout.split(/\r?\n/)) {
    if (line.startsWith('# branch.head ')) {
      const value = line.slice('# branch.head '.length).trim()
      branch = value === '(detached)' ? undefined : value
    } else if (line.startsWith('# branch.oid ')) {
      const value = line.slice('# branch.oid '.length).trim()
      head = value === '(initial)' ? undefined : value
    } else if (line.startsWith('# branch.upstream ')) {
      hasUpstream = true
    } else if (line.startsWith('# branch.ab ')) {
      const match = line.match(/\+(\d+)\s+-(\d+)/)
      if (match) {
        ahead = Number(match[1])
        behind = Number(match[2])
      }
    } else if (line.startsWith('1 ') || line.startsWith('2 ') || line.startsWith('u ')) {
      changedFiles += 1
    } else if (line.startsWith('? ')) {
      untrackedFiles += 1
    }
  }

  return { branch, head, changedFiles, untrackedFiles, ahead, behind, hasUpstream }
}

/**
 * Stashes live in the repository's common directory, not in the worktree, so the only
 * link back to a worktree is the message git writes when creating them.
 */
function countStashesOnBranch(stdout: string, branch: string): number {
  return stdout
    .split(/\r?\n/)
    .filter((line) => {
      const match = line.match(/^(?:WIP on|On) ([^:]+):/)
      return match?.[1].trim() === branch
    })
    .length
}

export function createWorktreeManager(options: WorktreeManagerOptions = {}): WorktreeManager {
  const runGit = options.runGit ?? runGitWithExecFile
  const pathExists = options.pathExists ?? existsSync

  const readCommonDir = async (cwd: string): Promise<string | null> => {
    const result = await runGit(['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd)
    return result.code === 0 && result.stdout.trim() ? normalizeGitPath(result.stdout) : null
  }

  const resolveBaseRef = async (projectPath: string): Promise<string> => {
    const symbolic = await runGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], projectPath)
    if (symbolic.code === 0 && symbolic.stdout.trim()) return symbolic.stdout.trim()
    const head = await runGit(['rev-parse', 'HEAD'], projectPath)
    return head.code === 0 && head.stdout.trim() ? head.stdout.trim() : 'HEAD'
  }

  const readStatus = async (request: WorktreeStatusRequest): Promise<WorktreeStatus> => {
    if (!pathExists(request.path)) return emptyStatus()

    const status = await runGit(
      ['status', '--porcelain=v2', '--branch', '--untracked-files=all'],
      request.path
    )
    if (status.code !== 0) {
      return { ...emptyStatus(status.stderr.trim() || 'git status failed'), exists: true }
    }

    const parsed = parsePorcelainStatus(status.stdout)
    const stash = await runGit(['stash', 'list', '--format=%gs'], request.path)
    const stashEntries = stash.code === 0
      ? countStashesOnBranch(stash.stdout, parsed.branch ?? request.branch)
      : 0

    // Without an upstream there is nothing to be "ahead" of, so fall back to the ref the
    // branch was cut from: those are the commits a teardown would strand.
    let ahead = parsed.ahead
    if (!parsed.hasUpstream) {
      const unmerged = await runGit(['rev-list', '--count', `${request.baseRef}..HEAD`], request.path)
      ahead = unmerged.code === 0 ? Number(unmerged.stdout.trim()) || 0 : 0
    }

    return { exists: true, ...parsed, ahead, stashEntries }
  }

  return {
    async create(request): Promise<WorktreeCreateResult> {
      const problem = branchNameProblem(request.branch)
      if (problem) return { ok: false, message: problem }

      try {
        const commonDir = await readCommonDir(request.projectPath)
        if (!commonDir) return { ok: false, message: `${request.projectPath} is not a git repository` }

        const format = await runGit(['check-ref-format', `refs/heads/${request.branch}`], request.projectPath)
        if (format.code !== 0) return { ok: false, message: `git rejected the branch name "${request.branch}"` }

        const existingBranch = await runGit(
          ['show-ref', '--verify', '--quiet', `refs/heads/${request.branch}`],
          request.projectPath
        )
        if (existingBranch.code === 0) {
          return { ok: false, message: `Branch "${request.branch}" already exists in this repository` }
        }

        const directory = deriveWorktreeDirectory(request.projectPath, request.branch)
        if (pathExists(directory)) return { ok: false, message: `${directory} already exists` }

        const baseRef = request.baseRef?.trim() || await resolveBaseRef(request.projectPath)
        const added = await runGit(
          ['worktree', 'add', '-b', request.branch, directory, baseRef],
          request.projectPath
        )
        if (added.code !== 0) {
          return { ok: false, message: added.stderr.trim() || added.stdout.trim() || 'git worktree add failed' }
        }

        return { ok: true, worktree: { path: directory, branch: request.branch, baseRef } }
      } catch (error) {
        return { ok: false, message: errorMessage(error) }
      }
    },

    async status(request): Promise<WorktreeStatus> {
      try {
        return await readStatus(request)
      } catch (error) {
        return { ...emptyStatus(errorMessage(error)), exists: pathExists(request.path) }
      }
    },

    async remove(request): Promise<WorktreeRemoveResult> {
      try {
        // A directory that is already gone leaves nothing to lose; prune the stale
        // registration so git and the workspace agree again.
        if (!pathExists(request.path)) {
          await runGit(['worktree', 'prune'], request.projectPath)
          return { ok: true, blockers: [] }
        }

        const projectCommonDir = await readCommonDir(request.projectPath)
        const worktreeCommonDir = await readCommonDir(request.path)
        if (!projectCommonDir || !worktreeCommonDir) {
          return {
            ok: false,
            blockers: [{ kind: 'not-a-worktree', detail: 'no git repository found' }]
          }
        }
        if (projectCommonDir !== worktreeCommonDir) {
          return {
            ok: false,
            blockers: [{ kind: 'not-a-worktree', detail: 'it belongs to a different repository' }]
          }
        }

        const gitDir = await runGit(['rev-parse', '--path-format=absolute', '--git-dir'], request.path)
        if (gitDir.code !== 0) {
          return { ok: false, blockers: [{ kind: 'inspection-failed', detail: 'git rev-parse --git-dir failed' }] }
        }
        // A linked worktree has its own git dir under the common dir; the primary shares it.
        if (normalizeGitPath(gitDir.stdout) === worktreeCommonDir) {
          return { ok: false, blockers: [{ kind: 'primary-worktree' }] }
        }

        const status = await readStatus(request)
        if (status.message) {
          return { ok: false, blockers: [{ kind: 'inspection-failed', detail: status.message }] }
        }

        const blockers: WorktreeRemovalBlocker[] = []
        if (status.changedFiles > 0) blockers.push({ kind: 'uncommitted-changes', files: status.changedFiles })
        if (status.untrackedFiles > 0) blockers.push({ kind: 'untracked-files', files: status.untrackedFiles })
        if (status.stashEntries > 0) blockers.push({ kind: 'stashed-changes', entries: status.stashEntries })
        if (status.ahead > 0) blockers.push({ kind: 'unpublished-commits', commits: status.ahead })

        const refused = request.force ? blockers.filter((blocker) => !isForcibleBlocker(blocker)) : blockers
        if (refused.length > 0) return { ok: false, blockers: refused }

        const removed = await runGit(
          ['worktree', 'remove', ...(request.force ? ['--force'] : []), request.path],
          request.projectPath
        )
        if (removed.code !== 0) {
          return {
            ok: false,
            blockers: [],
            message: removed.stderr.trim() || removed.stdout.trim() || 'git worktree remove failed'
          }
        }

        await runGit(['worktree', 'prune'], request.projectPath)
        return { ok: true, blockers: [] }
      } catch (error) {
        return { ok: false, blockers: [{ kind: 'inspection-failed', detail: errorMessage(error) }] }
      }
    },

    async discover(request): Promise<WorktreeDiscoverResult> {
      try {
        const listed = await runGit(['worktree', 'list', '--porcelain'], request.projectPath)
        if (listed.code !== 0) {
          return { worktrees: [], message: listed.stderr.trim() || 'git worktree list failed' }
        }

        const commonDir = await readCommonDir(request.projectPath)
        const claims = commonDir ? readClaims(join(commonDir, WORKTREE_CLAIMS_FILE)) : []
        const defaultBranch = await resolveBaseRef(request.projectPath)

        return {
          worktrees: discoverWorktrees(
            parseWorktreeList(listed.stdout),
            request.known.map((path) => ({ path })),
            claims,
            defaultBranch
          )
        }
      } catch (error) {
        return { worktrees: [], message: errorMessage(error) }
      }
    }
  }
}

import { execFile } from 'node:child_process'
import { hiddenProcessOptions } from './background-process'
import { existsSync, readFileSync, lstatSync } from 'node:fs'
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
  WorktreeStatus,
  WorktreeStatusRequest
} from '../shared/worktree'
import {
  WORKTREE_CLAIMS_FILE,
  branchNameProblem,
  deriveWorktreeDirectory,
  discoverWorktrees,
  isForcibleBlocker,
  matchWorktreeClaims,
  normalizeWorktreePath,
  worktreePathKey,
  parseWorktreeList
} from '../shared/worktree'
import { errorMessage } from '../shared/text'
import {
  LOCAL_BRANCH_FORMAT,
  parseLocalBranches,
  type GitBranchListResult,
  type GitBranchState,
  type GitCheckoutRequest,
  type GitCheckoutResult
} from '../shared/git-branch'
import type { GitDiffRequest, GitDiffSummary, GitFileDiff, GitFileDiffRequest } from '../shared/git-diff'
import { changedFilesFromGit, parseUnifiedDiff } from '../shared/git-diff'
import type { SessionOutcomeCodeState } from '../shared/session-outcome'

/**
 * Claims are a hint written by an agent, so every failure mode - missing file, malformed
 * JSON, an entry of the wrong shape - costs the association and nothing else.
 */
function readClaims(path: string): WorktreeClaim[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (claim): claim is WorktreeClaim =>
        Boolean(claim) &&
        typeof claim === 'object' &&
        typeof (claim as WorktreeClaim).nodeId === 'string' &&
        typeof (claim as WorktreeClaim).path === 'string' &&
        typeof (claim as WorktreeClaim).branch === 'string'
    )
  } catch {
    return []
  }
}

export interface GitResult {
  /** A git exit status, or `GIT_LAUNCH_FAILED` when git never ran at all. */
  code: number
  stdout: string
  stderr: string
}

/**
 * git never ran: the binary is missing from PATH, the spawn was refused, or the child died
 * outside an exit status. `execFile` reports all of those as a *string* `error.code`
 * (`ENOENT`, `ERR_CHILD_PROCESS_STDIO_MAXBUFFER`), which is not an exit status, so folding them
 * into `1` made every caller answer "not a git repository" for a git that was simply absent.
 *
 * Every caller inside this module reports it as prose, so nothing outside needs the code itself.
 * @internal exported for tests
 */
export const GIT_LAUNCH_FAILED = -1

/**
 * Turns one `execFile` callback into a `GitResult`.
 * @internal exported for tests
 */
export function gitResultFromExecFile(
  error: { code?: unknown; message?: string } | null,
  stdout: string,
  stderr: string
): GitResult {
  if (!error) return { code: 0, stdout: stdout ?? '', stderr: stderr ?? '' }
  if (typeof error.code === 'number') return { code: error.code, stdout: stdout ?? '', stderr: stderr ?? '' }
  return { code: GIT_LAUNCH_FAILED, stdout: stdout ?? '', stderr: (stderr ?? '').trim() || (error.message ?? '') }
}

/**
 * The message for a git that never ran, or null when it ran and merely failed. Separate from
 * `gitFailureMessage` because several callers have a precise thing to say about a *failed* git
 * ("not a local branch", "is not a git repository") that would be a lie about an absent one.
 */
function gitUnavailable(result: GitResult): string | null {
  if (result.code !== GIT_LAUNCH_FAILED) return null
  return `git could not be run: ${result.stderr.trim() || 'unknown error'}`
}

/**
 * The one message for a failed git run: a launch failure names itself so the reader knows the
 * answer is about their machine and not about their checkout, and everything else keeps git's
 * own words.
 */
function gitFailureMessage(result: GitResult, fallback: string): string {
  return gitUnavailable(result) || result.stderr.trim() || result.stdout.trim() || fallback
}

export type GitRunner = (args: string[], cwd: string) => Promise<GitResult>

export interface WorktreeManagerOptions {
  runGit?: GitRunner
  pathExists?(path: string): boolean
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
  /**
   * Whether git knows this path as a checkout at all. Here rather than beside its one caller
   * because it is the same `rev-parse` probe `discover` and `remove` already lean on, and a second
   * way of asking would eventually answer differently.
   */
  isRepository(path: string): Promise<boolean>
  /**
   * Which branch a checkout is on right now. Read-only and best-effort like `isRepository`,
   * which it deliberately answers as part of its result: a caller that only wants to show a
   * branch would otherwise have to ask git the same question twice.
   */
  currentBranch(path: string): Promise<GitBranchState>
  /**
   * The full `HEAD` commit of a checkout and the branch it is on, for the session outcome index
   * (#17). `null` for anything that has no commit to name - a missing path, a non-repository, an
   * unborn branch, or a git that will not run - because a guessed code state would tell a later
   * session a failure is current when nobody knows.
   */
  codeState(path: string): Promise<SessionOutcomeCodeState | null>
  /**
   * Every local branch of a checkout, each with the worktree that already has it checked out so
   * the switcher can refuse those up front. Remote-only branches are deliberately not listed:
   * picking one would create a tracking branch, which is a different operation than switching.
   */
  listBranches(path: string): Promise<GitBranchListResult>
  /**
   * Checks an existing local branch out. The branch is verified first because a bare
   * `git checkout <name>` would otherwise happily create one from a same-named remote branch.
   */
  checkoutBranch(request: GitCheckoutRequest): Promise<GitCheckoutResult>
  /**
   * What a checkout has changed against its base: the file list only, with counts. Hunks are
   * read per file through `diffFile`, never for the whole tree at once, so a large review costs
   * one bounded git run per file the reader actually opens.
   */
  diff(request: GitDiffRequest): Promise<GitDiffSummary>
  diffFile(request: GitFileDiffRequest): Promise<GitFileDiff>
}

const GIT_MAX_BUFFER = 8 * 1024 * 1024

const runGitWithExecFile: GitRunner = (args, cwd) =>
  new Promise<GitResult>((resolve) => {
    execFile('git', args, hiddenProcessOptions({ cwd, maxBuffer: GIT_MAX_BUFFER }), (error, stdout, stderr) => {
      resolve(gitResultFromExecFile(error, stdout, stderr))
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
  return worktreePathKey(value.trim())
}

function parsePorcelainStatus(
  stdout: string
): Pick<WorktreeStatus, 'branch' | 'head' | 'changedFiles' | 'untrackedFiles' | 'ahead' | 'behind' | 'hasUpstream'> {
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
  return stdout.split(/\r?\n/).filter((line) => {
    const match = line.match(/^(?:WIP on|On) ([^:]+):/)
    return match?.[1].trim() === branch
  }).length
}

export function createWorktreeManager(options: WorktreeManagerOptions = {}): WorktreeManager {
  const runGit = options.runGit ?? runGitWithExecFile
  const pathExists = options.pathExists ?? existsSync

  /**
   * `path` is null both for a directory that is no checkout and for a git that would not start;
   * `unavailable` is what tells those apart, and is the message a caller should prefer.
   */
  const readCommonDir = async (cwd: string): Promise<{ path: string | null; unavailable?: string }> => {
    const result = await runGit(['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd)
    const unavailable = gitUnavailable(result)
    if (unavailable) return { path: null, unavailable }
    return { path: result.code === 0 && result.stdout.trim() ? normalizeGitPath(result.stdout) : null }
  }

  const resolveBaseRef = async (projectPath: string): Promise<string> => {
    const symbolic = await runGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], projectPath)
    if (symbolic.code === 0 && symbolic.stdout.trim()) return symbolic.stdout.trim()
    const head = await runGit(['rev-parse', 'HEAD'], projectPath)
    return head.code === 0 && head.stdout.trim() ? head.stdout.trim() : 'HEAD'
  }

  const readStatus = async (request: WorktreeStatusRequest): Promise<WorktreeStatus> => {
    if (!pathExists(request.path)) return emptyStatus()

    const status = await runGit(['status', '--porcelain=v2', '--branch', '--untracked-files=all'], request.path)
    if (status.code !== 0) {
      return { ...emptyStatus(gitFailureMessage(status, 'git status failed')), exists: true }
    }

    const parsed = parsePorcelainStatus(status.stdout)
    const stash = await runGit(['stash', 'list', '--format=%gs'], request.path)
    const stashEntries = stash.code === 0 ? countStashesOnBranch(stash.stdout, parsed.branch ?? request.branch) : 0

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
        if (!commonDir.path) {
          return { ok: false, message: commonDir.unavailable ?? `${request.projectPath} is not a git repository` }
        }

        const format = await runGit(['check-ref-format', `refs/heads/${request.branch}`], request.projectPath)
        if (format.code !== 0) {
          return { ok: false, message: gitUnavailable(format) ?? `git rejected the branch name "${request.branch}"` }
        }

        const existingBranch = await runGit(
          ['show-ref', '--verify', '--quiet', `refs/heads/${request.branch}`],
          request.projectPath
        )
        if (existingBranch.code === 0) {
          return { ok: false, message: `Branch "${request.branch}" already exists in this repository` }
        }

        const directory = normalizeWorktreePath(deriveWorktreeDirectory(request.projectPath, request.branch))
        if (pathExists(directory)) return { ok: false, message: `${directory} already exists` }

        const baseRef = request.baseRef?.trim() || (await resolveBaseRef(request.projectPath))
        const added = await runGit(['worktree', 'add', '-b', request.branch, directory, baseRef], request.projectPath)
        if (added.code !== 0) {
          return { ok: false, message: gitFailureMessage(added, 'git worktree add failed') }
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
        // A git that will not start is no evidence about this worktree, so it blocks removal as a
        // failed inspection rather than as the verdict "this is not a worktree".
        const unavailable = projectCommonDir.unavailable ?? worktreeCommonDir.unavailable
        if (unavailable) return { ok: false, blockers: [{ kind: 'inspection-failed', detail: unavailable }] }
        if (!projectCommonDir.path || !worktreeCommonDir.path) {
          return {
            ok: false,
            blockers: [{ kind: 'not-a-worktree', detail: 'no git repository found' }]
          }
        }
        if (projectCommonDir.path !== worktreeCommonDir.path) {
          return {
            ok: false,
            blockers: [{ kind: 'not-a-worktree', detail: 'it belongs to a different repository' }]
          }
        }

        const gitDir = await runGit(['rev-parse', '--path-format=absolute', '--git-dir'], request.path)
        if (gitDir.code !== 0) {
          const detail = gitFailureMessage(gitDir, 'git rev-parse --git-dir failed')
          return { ok: false, blockers: [{ kind: 'inspection-failed', detail }] }
        }
        // A linked worktree has its own git dir under the common dir; the primary shares it.
        if (normalizeGitPath(gitDir.stdout) === worktreeCommonDir.path) {
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
            message: gitFailureMessage(removed, 'git worktree remove failed')
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
          return { worktrees: [], claims: [], message: gitFailureMessage(listed, 'git worktree list failed') }
        }

        const commonDir = (await readCommonDir(request.projectPath)).path
        const claims = commonDir ? readClaims(join(commonDir, WORKTREE_CLAIMS_FILE)) : []
        const defaultBranch = await resolveBaseRef(request.projectPath)
        const entries = parseWorktreeList(listed.stdout)
        // An empty/malformed successful response is not evidence of absence. lstat preserves
        // broken .git links and permission failures; neither permits forgetting a checkout.
        const registered = new Set(entries.map((entry) => worktreePathKey(entry.path)))
        const stalePaths =
          entries.length === 0
            ? []
            : request.known.filter((path) => {
                if (registered.has(worktreePathKey(path))) return false
                try {
                  lstatSync(join(normalizeWorktreePath(path), '.git'))
                  return false
                } catch (error) {
                  return (error as NodeJS.ErrnoException).code === 'ENOENT'
                }
              })

        return {
          stalePaths,
          availablePaths: entries.map((entry) => entry.path),
          worktrees: discoverWorktrees(
            entries,
            request.known.map((path) => ({ path })),
            defaultBranch
          ),
          claims: matchWorktreeClaims(entries, claims)
        }
      } catch (error) {
        return { worktrees: [], claims: [], message: errorMessage(error) }
      }
    },

    async diff(request): Promise<GitDiffSummary> {
      try {
        if (!pathExists(request.path)) {
          return { ok: false, reason: 'missing', message: `${request.path} is not on disk` }
        }
        const commonDir = await readCommonDir(request.path)
        if (commonDir.unavailable) return { ok: false, reason: 'failed', message: commonDir.unavailable }
        if (commonDir.path === null) {
          return { ok: false, reason: 'not-a-repository', message: `${request.path} is not a git repository` }
        }
        const [nameStatus, numstat, status, symbolic] = await Promise.all([
          runGit(['diff', '-z', '-M', '--name-status', request.baseRef], request.path),
          runGit(['diff', '-z', '-M', '--numstat', request.baseRef], request.path),
          runGit(['status', '--porcelain=v1', '-z', '--untracked-files=all'], request.path),
          runGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], request.path)
        ])
        const failure = [nameStatus, numstat, status].find((result) => result.code !== 0)
        if (failure) {
          return { ok: false, reason: 'failed', message: gitFailureMessage(failure, 'git diff failed') }
        }
        const branch = symbolic.code === 0 ? symbolic.stdout.trim() || undefined : undefined
        return {
          ok: true,
          ...(branch ? { branch } : {}),
          files: changedFilesFromGit({ nameStatus: nameStatus.stdout, numstat: numstat.stdout, status: status.stdout })
        }
      } catch (error) {
        return { ok: false, reason: 'failed', message: errorMessage(error) }
      }
    },

    async diffFile(request): Promise<GitFileDiff> {
      const { file } = request
      try {
        // An untracked file has nothing in the base to compare with, so it is shown whole against
        // nothing; `--no-index` exits 1 whenever the two sides differ, which here is always.
        const result =
          file.status === 'untracked'
            ? await runGit(['diff', '--no-index', '--', '/dev/null', file.path], request.path)
            : await runGit(
                ['diff', '-M', request.baseRef, '--', ...(file.oldPath ? [file.oldPath] : []), file.path],
                request.path
              )
        const accepted = result.code === 0 || (file.status === 'untracked' && result.code === 1)
        if (!accepted) return { ok: false, message: gitFailureMessage(result, 'git diff failed') }
        return { ok: true, ...parseUnifiedDiff(result.stdout) }
      } catch (error) {
        return { ok: false, message: errorMessage(error) }
      }
    },

    async currentBranch(path): Promise<GitBranchState> {
      // Like `isRepository`, a git that will not run answers `isRepository: false` - `GitBranchState`
      // feeds a branch indicator with nowhere to put a message, and hiding the row is the honest
      // display for "this cannot be determined". The surfaces that must explain themselves -
      // `create`, `status`, `listBranches`, `diff`, `remove` - all carry the message instead.
      try {
        if (!pathExists(path) || (await readCommonDir(path)).path === null) return { isRepository: false }
        const symbolic = await runGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], path)
        if (symbolic.code === 0 && symbolic.stdout.trim()) return { isRepository: true, branch: symbolic.stdout.trim() }
        // No symbolic ref means a detached HEAD - or a repository with no commits yet, where
        // `rev-parse` fails too and the branch is simply unnameable.
        const head = await runGit(['rev-parse', '--short', 'HEAD'], path)
        const detachedHead = head.code === 0 ? head.stdout.trim() : ''
        return { isRepository: true, ...(detachedHead ? { detachedHead } : {}) }
      } catch {
        return { isRepository: false }
      }
    },

    async codeState(path): Promise<SessionOutcomeCodeState | null> {
      try {
        if (!pathExists(path)) return null
        const head = await runGit(['rev-parse', '--verify', '--quiet', 'HEAD'], path)
        const commit = head.code === 0 ? head.stdout.trim() : ''
        if (!commit) return null
        const symbolic = await runGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], path)
        const branch = symbolic.code === 0 ? symbolic.stdout.trim() : ''
        return { commit, ...(branch ? { branch } : {}) }
      } catch {
        return null
      }
    },

    async listBranches(path): Promise<GitBranchListResult> {
      try {
        if (!pathExists(path)) return { ok: false, branches: [], message: 'Not a git repository' }
        const commonDir = await readCommonDir(path)
        if (commonDir.path === null) {
          return { ok: false, branches: [], message: commonDir.unavailable ?? 'Not a git repository' }
        }
        const listed = await runGit(['branch', '--list', `--format=${LOCAL_BRANCH_FORMAT}`], path)
        if (listed.code !== 0) {
          return { ok: false, branches: [], message: gitFailureMessage(listed, 'git branch failed') }
        }
        return { ok: true, branches: parseLocalBranches(listed.stdout) }
      } catch (error) {
        return { ok: false, branches: [], message: errorMessage(error) }
      }
    },

    async checkoutBranch(request): Promise<GitCheckoutResult> {
      try {
        const branch = request.branch.trim()
        if (!branch) return { ok: false, message: 'No branch named' }
        const exists = await runGit(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], request.path)
        if (exists.code !== 0) {
          return { ok: false, message: gitUnavailable(exists) ?? `${branch} is not a local branch` }
        }
        const checkout = await runGit(['checkout', branch, '--'], request.path)
        if (checkout.code !== 0) {
          return { ok: false, message: gitFailureMessage(checkout, `git checkout ${branch} failed`) }
        }
        return { ok: true }
      } catch (error) {
        return { ok: false, message: errorMessage(error) }
      }
    },

    async isRepository(path): Promise<boolean> {
      // Anything that is not a repository - a missing path, a git that will not run - is `false`,
      // because every caller uses this to decide whether it may promise history keeps something.
      try {
        return pathExists(path) && (await readCommonDir(path)).path !== null
      } catch {
        return false
      }
    }
  }
}

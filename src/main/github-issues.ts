import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import { hiddenProcessOptions } from './background-process'
import {
  DEFAULT_GITHUB_STATUS_LABELS,
  GITHUB_ISSUE_FIELDS,
  githubRemoteRepository,
  parseGithubIssues,
  type GithubStatusLabels
} from '../shared/github-issues'
import type { TicketGithubListResult, TicketSourceAvailability, TicketSourceUnavailable } from '../shared/ticket-source'

/**
 * The GitHub ticket source's one contact with the machine: it asks git which remotes a checkout
 * has and asks `gh` for that repository's issues. Everything it then knows about issues is decided
 * in `shared/github-issues.ts`, so this module holds only the parts a test cannot run twice - a
 * subprocess and a PATH lookup - behind injected seams.
 *
 * Nothing here throws. A machine without `gh`, a project on another host, an expired login: each
 * is an answer with a reason the board can print, because a tracker that is merely absent must
 * never look like a tracker with no issues.
 */

/** Beyond this the board stops being a board; `gh` orders newest first, so the tail is oldest. */
const ISSUE_LIMIT = 200
const MAX_BUFFER = 8 * 1024 * 1024
/** Long enough that opening the board costs one probe, short enough that a refresh re-checks. */
const PROBE_TTL_MS = 10_000

export interface CommandResult {
  code: number
  stdout: string
  stderr: string
}

export type GithubCommandRunner = (command: string, args: string[], cwd: string) => Promise<CommandResult>

export interface GithubIssueReaderOptions {
  /**
   * Where a command actually lives, or `null` when it is not installed. Injected because the
   * answer is the user's machine, and because resolving it is how "no `gh`" stays a reason rather
   * than an ENOENT thrown out of a subprocess.
   */
  resolveCommand(command: string): Promise<string | null>
  run?: GithubCommandRunner
  limit?: number
  pathExists?(path: string): boolean
  /** How long a probe stands before it is asked again; a manual refresh past it re-checks. */
  probeTtlMs?: number
  /**
   * Which labels this project maps to columns. Read per listing rather than once, because the
   * label is a workspace setting the user may change while the board is open.
   */
  statusLabelsFor?(projectPath: string): GithubStatusLabels | Promise<GithubStatusLabels>
}

/** A project that has a GitHub source, or the reason it does not. */
type GithubProbe = { gh: string; repository: string } | TicketSourceUnavailable

export interface GithubIssueReader {
  /** A PATH lookup, `git remote -v` and `gh auth status`. Never lists issues. */
  availability(projectPath: string): Promise<TicketSourceAvailability>
  list(projectPath: string): Promise<TicketGithubListResult>
}

const NO_CLI: TicketSourceUnavailable = {
  available: false,
  reason: 'The GitHub CLI (gh) was not found. Install it to see this project’s issues.'
}

const NO_REMOTE: TicketSourceUnavailable = { available: false, reason: 'This project has no GitHub remote.' }

const NO_AUTH_FALLBACK = 'The GitHub CLI is not signed in. Run gh auth login.'

/**
 * npm-style `.cmd` shims cannot be launched by `execFile` on current Node (EINVAL), and hiding an
 * intermediate wrapper does not stop its inherited-stdio child briefly surfacing a console window
 * (see AGENTS.md). `gh` normally resolves to a native executable; when the lookup lands on a shim,
 * a sibling `.exe` of the same name is the binary that shim exists to call.
 */
function nativeCommand(command: string, exists: (path: string) => boolean): string {
  if (!['.cmd', '.bat'].includes(extname(command).toLowerCase())) return command
  const native = join(dirname(command), `${basename(command, extname(command))}.exe`)
  return exists(native) ? native : command
}

const runWithExecFile: GithubCommandRunner = (command, args, cwd) =>
  new Promise<CommandResult>((resolve) => {
    execFile(command, args, hiddenProcessOptions({ cwd, maxBuffer: MAX_BUFFER }), (error, stdout, stderr) => {
      const code =
        error && typeof (error as { code?: unknown }).code === 'number'
          ? (error as { code: number }).code
          : error
            ? 1
            : 0
      resolve({ code, stdout: stdout ?? '', stderr: stderr ?? '' })
    })
  })

export function createGithubIssueReader(options: GithubIssueReaderOptions): GithubIssueReader {
  const run = options.run ?? runWithExecFile
  const limit = options.limit ?? ISSUE_LIMIT
  const exists = options.pathExists ?? existsSync
  const probeTtlMs = options.probeTtlMs ?? PROBE_TTL_MS
  const statusLabelsFor = options.statusLabelsFor ?? ((): GithubStatusLabels => DEFAULT_GITHUB_STATUS_LABELS)
  /** The last probe per project, so opening the board does not pay for the same three answers. */
  const probes = new Map<string, { at: number; result: Promise<GithubProbe> }>()

  /**
   * Both entry points start here, so the toggle the board offers and the listing behind it can
   * never disagree about whether this project has a GitHub source at all. Three questions, in
   * increasing cost, each answered only when the cheaper ones said yes.
   */
  async function probeOnce(projectPath: string): Promise<GithubProbe> {
    const resolved = await options.resolveCommand('gh')
    if (!resolved) return NO_CLI
    const gh = nativeCommand(resolved, exists)
    const git = nativeCommand((await options.resolveCommand('git')) ?? 'git', exists)
    const remotes = await run(git, ['remote', '-v'], projectPath)
    // A folder git refuses to read is a folder with no GitHub remote: the distinction changes
    // nothing the user can act on from a ticket board.
    const repository = remotes.code === 0 ? githubRemoteRepository(remotes.stdout) : null
    if (!repository) return NO_REMOTE
    // Asked here rather than left to the listing, so a toggle is never offered for a CLI that
    // will refuse the moment it is switched on. gh writes its sign-in advice to stderr.
    const auth = await run(gh, ['auth', 'status'], projectPath)
    if (auth.code !== 0) {
      return { available: false, reason: auth.stderr.trim() || auth.stdout.trim() || NO_AUTH_FALLBACK }
    }
    return { gh, repository }
  }

  function probe(projectPath: string): Promise<GithubProbe> {
    const cached = probes.get(projectPath)
    if (cached && Date.now() - cached.at < probeTtlMs) return cached.result
    const result = probeOnce(projectPath)
    probes.set(projectPath, { at: Date.now(), result })
    // A probe that rejected must not be remembered as this project's answer.
    void result.catch(() => probes.delete(projectPath))
    return result
  }

  return {
    async availability(projectPath) {
      const probed = await probe(projectPath)
      return 'available' in probed ? probed : { available: true, detail: probed.repository }
    },

    async list(projectPath) {
      const probed = await probe(projectPath)
      if ('available' in probed) return probed
      const issues = await run(
        probed.gh,
        ['issue', 'list', '--state', 'all', '--json', GITHUB_ISSUE_FIELDS.join(','), '--limit', String(limit)],
        projectPath
      )
      if (issues.code !== 0) {
        return {
          available: false,
          // gh explains itself well - an expired login, a repository without issues enabled - so
          // its own words beat anything Toucan could guess from an exit code.
          reason: issues.stderr.trim() || `gh issue list exited with code ${issues.code}.`
        }
      }
      return { available: true, ...parseGithubIssues(issues.stdout, await statusLabelsFor(projectPath)) }
    }
  }
}

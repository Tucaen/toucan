import { execFile } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { readdir, rm } from 'node:fs/promises'
import { isAbsolute, join, parse, resolve } from 'node:path'
import { errorMessage } from '../shared/text'
import { hiddenProcessOptions } from './background-process'

/** `GitRunner`'s shape, restated because `git-worktree.ts` imports this module. */
type GitRunner = (args: string[], cwd: string) => Promise<{ code: number; stdout: string; stderr: string }>
/**
 * What is left of a worktree after `git worktree remove` failed half-way. Git deletes the
 * folder first and the registration second, and carries on to the second when the first fails,
 * so a folder git could not empty - classically one holding ignored build output deeper than
 * Windows' 260-character `MAX_PATH` - outlives its registration. Everything here reads or
 * deletes only below the one folder it is handed.
 */

/** Windows' classic `MAX_PATH`, counting the terminating NUL: a usable path is at most 259. */
const MAX_PATH = 260

/** A conservative command-line budget per git call; Windows allows 32 767 characters. */
const ARGUMENT_BUDGET = 24_000

function assertDeletable(path: string): string {
  if (!isAbsolute(path)) throw new Error(`refusing to delete a relative path: ${path}`)
  const absolute = resolve(path)
  if (parse(absolute).root === absolute) throw new Error(`refusing to delete a filesystem root: ${absolute}`)
  return absolute
}

/** The `\\?\` form Windows APIs accept beyond `MAX_PATH`; other platforms have no such limit. */
function extendedLengthPath(absolute: string): string {
  if (process.platform !== 'win32' || absolute.startsWith('\\\\?\\')) return absolute
  return absolute.startsWith('\\\\') ? `\\\\?\\UNC\\${absolute.slice(2)}` : `\\\\?\\${absolute}`
}

function removeWithRd(absolute: string): Promise<void> {
  return new Promise((done, fail) => {
    execFile(
      'cmd.exe',
      ['/d', '/c', 'rd', '/s', '/q', extendedLengthPath(absolute)],
      hiddenProcessOptions({}),
      (error, _stdout, stderr) => (error ? fail(new Error(String(stderr).trim() || error.message)) : done())
    )
  })
}

/**
 * Deletes `path` and everything below it, long paths included. Links inside are removed, never
 * followed. Node already lifts `MAX_PATH`; `rd /s /q` on the `\\?\` form is the fallback for the
 * Windows failures Node's retries do not outlast.
 */
export async function removeTree(path: string): Promise<void> {
  const absolute = assertDeletable(path)
  let failure: unknown
  try {
    await rm(extendedLengthPath(absolute), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  } catch (error) {
    failure = error
  }
  if (existsSync(absolute) && process.platform === 'win32') {
    try {
      await removeWithRd(absolute)
    } catch (error) {
      failure ??= error
    }
  }
  if (existsSync(absolute)) throw new Error(failure ? errorMessage(failure) : `${absolute} could not be deleted`)
}

async function longestPathBelow(root: string): Promise<{ path: string; length: number } | null> {
  let longest: { path: string; length: number } | null = null
  const pending = [resolve(root)]
  while (pending.length > 0) {
    const directory = pending.pop()!
    let entries
    try {
      entries = await readdir(extendedLengthPath(directory), { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (!longest || path.length > longest.length) longest = { path, length: path.length }
      if (entry.isDirectory()) pending.push(path)
    }
  }
  return longest
}

/**
 * `cause`, plus the long-path diagnosis when the folder is why: the longest remaining path, its
 * length, and what the user can change.
 */
export async function describeRemovalFailure(path: string, cause: string): Promise<string> {
  const longest = await longestPathBelow(path)
  if (!longest || (longest.length < MAX_PATH && !/filename too long|ENAMETOOLONG/i.test(cause))) return cause
  return (
    `${cause} - Windows path length limit: the longest remaining path is ${longest.length} characters ` +
    `(${longest.path}), over the ${MAX_PATH}-character MAX_PATH. Enable long paths (LongPathsEnabled=1 under ` +
    `HKLM\\SYSTEM\\CurrentControlSet\\Control\\FileSystem, and git config --global core.longpaths true) or use ` +
    `a shorter worktree root`
  )
}

function chunks(items: string[]): string[][] {
  const result: string[][] = []
  let current: string[] = []
  let size = 0
  for (const item of items) {
    if (current.length > 0 && size + item.length + 3 > ARGUMENT_BUDGET) {
      result.push(current)
      current = []
      size = 0
    }
    current.push(item)
    size += item.length + 3
  }
  if (current.length > 0) result.push(current)
  return result
}

const FINDINGS_SHOWN = 5

/**
 * What in a leftover worktree folder is still somebody's work, as one line per finding; empty
 * means everything left is either git-ignored or byte-identical to a file in one of `refs`.
 *
 * Ignore rules come from the project checkout, not the folder: git may already have deleted the
 * folder's own `.gitignore` files, and the caller has verified the checkout is on the target the
 * ticket merged into. File contents are compared through `hash-object`, so the checkout's
 * line-ending configuration applies exactly as it did when git wrote them.
 */
export async function inspectLeftover(options: {
  runGit: GitRunner
  projectPath: string
  folder: string
  refs: string[]
}): Promise<string[]> {
  const { runGit, projectPath } = options
  const folder = resolve(options.folder)
  const git = async (args: string[], accept: number[] = [0]): Promise<string> => {
    const result = await runGit(args, projectPath)
    if (!accept.includes(result.code)) throw new Error(result.stderr.trim() || `git ${args[0]} failed`)
    return result.stdout
  }
  const findings: string[] = []

  const dotGit = join(folder, '.git')
  if (existsSync(dotGit)) {
    if (statSync(dotGit).isDirectory()) findings.push('.git is a repository of its own')
    else {
      const linked = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, 'utf8'))?.[1]?.trim()
      if (linked && existsSync(resolve(folder, linked))) findings.push(`.git still links to ${linked}`)
    }
  }

  // Breadth-first so an ignored directory - node_modules, a test-run tree - is judged once and
  // never walked.
  const files: string[] = []
  let level = ['']
  while (level.length > 0) {
    const entries: { relative: string; directory: boolean; link: boolean }[] = []
    for (const directory of level) {
      const listed = await readdir(extendedLengthPath(join(folder, directory)), { withFileTypes: true })
      for (const entry of listed) {
        if (directory === '' && entry.name === '.git') continue
        entries.push({
          relative: directory ? `${directory}/${entry.name}` : entry.name,
          directory: entry.isDirectory(),
          link: entry.isSymbolicLink()
        })
      }
    }
    const ignored = new Set<string>()
    const probes = entries.map((entry) => (entry.directory ? `${entry.relative}/` : entry.relative))
    // `-z` needs `--stdin`, which the runner has not got. A name git still quotes despite
    // `core.quotePath=false` just fails to match and is reported, never deleted unchecked.
    for (const batch of chunks(probes)) {
      const output = await git(['-c', 'core.quotePath=false', 'check-ignore', '--no-index', '--', ...batch], [0, 1])
      for (const path of output.split(/\r?\n/)) if (path) ignored.add(path.replace(/\/$/, ''))
    }
    level = []
    for (const entry of entries) {
      if (ignored.has(entry.relative)) continue
      if (entry.link) findings.push(`link ${entry.relative}`)
      else if (entry.directory) level.push(entry.relative)
      else files.push(entry.relative)
    }
  }

  if (files.length > 0) {
    const known = new Map<string, Set<string>>()
    for (const ref of options.refs) {
      for (const line of (await git(['ls-tree', '-r', '-z', ref])).split('\0')) {
        const match = /^\d+ blob ([0-9a-f]+)\t(.+)$/.exec(line)
        if (!match) continue
        const blobs = known.get(match[2]) ?? new Set<string>()
        blobs.add(match[1])
        known.set(match[2], blobs)
      }
    }
    const candidates = files.filter((file) => known.has(file))
    for (const file of files) if (!known.has(file)) findings.push(`untracked ${file}`)
    for (const batch of chunks(candidates)) {
      const hashes = (await git(['hash-object', '--', ...batch.map((file) => join(folder, file))]))
        .split(/\r?\n/)
        .filter(Boolean)
      batch.forEach((file, index) => {
        if (!known.get(file)!.has(hashes[index])) findings.push(`modified ${file}`)
      })
    }
  }

  if (findings.length <= FINDINGS_SHOWN) return findings
  return [...findings.slice(0, FINDINGS_SHOWN), `and ${findings.length - FINDINGS_SHOWN} more`]
}

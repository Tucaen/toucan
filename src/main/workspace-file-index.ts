import { execFile } from 'node:child_process'
import type { Dirent } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { hiddenProcessOptions } from './background-process'
import { WORKSPACE_FILE_INDEX_LIMIT, type WorkspaceFileEntry, type WorkspaceFileIndex } from '../shared/workspace-files'

/** What a listing produced: `ok: false` means this source could not speak for the directory. */
export interface TrackedFileListing {
  ok: boolean
  paths?: string[]
}

export interface WalkResult {
  paths: string[]
  truncated: boolean
}

export interface WorkspaceFileIndexOptions {
  /** Reads the directory through git, so git's own exclude rules shape the list. */
  listTracked?(root: string, limit: number): Promise<TrackedFileListing>
  /** Used only where git cannot speak for the directory. */
  walk?(root: string, limit: number): Promise<WalkResult>
  now?(): number
  ttlMs?: number
  limit?: number
}

export interface WorkspaceFileIndexReader {
  read(root: string): Promise<WorkspaceFileIndex>
}

/**
 * How long one directory's listing is reused. Long enough that typing a path never spawns git
 * twice, short enough that a file created a moment ago is mentionable without restarting.
 */
const DEFAULT_TTL_MS = 15_000

/** git's own output cap. A repository past this is already past what the picker will show. */
const GIT_MAX_BUFFER = 16 * 1024 * 1024

/**
 * Directories the fallback walk never descends into. This list only matters where git cannot
 * answer - inside a checkout `.gitignore` is the authority, and this would be second-guessing it.
 */
const UNWALKED_DIRECTORIES = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  'dist',
  'dist-out',
  'out',
  'build',
  'coverage',
  '.next',
  '.turbo',
  '.venv',
  '__pycache__',
  'target',
  'vendor'
])

/**
 * `--cached --others --exclude-standard` is exactly "everything in the working tree that git is
 * not ignoring": tracked files plus untracked ones, minus `.gitignore`, `.git/info/exclude` and
 * the global excludes. `-z` keeps unusual filenames intact instead of arriving quoted, and paths
 * come back relative to the directory git was run in - the node's own working directory.
 */
const listWithGit = (root: string): Promise<TrackedFileListing> =>
  new Promise((resolve) => {
    execFile(
      'git',
      ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
      hiddenProcessOptions({ cwd: root, maxBuffer: GIT_MAX_BUFFER }),
      (error, stdout) => {
        if (error) return resolve({ ok: false })
        resolve({ ok: true, paths: stdout.split('\0').filter(Boolean) })
      }
    )
  })

/**
 * The non-git fallback: a breadth-first walk that stops at the same cap the index publishes, so
 * a directory nobody has put under version control still offers something without the walk
 * itself becoming the reason the composer stutters.
 */
async function walkDirectory(root: string, limit: number): Promise<WalkResult> {
  const paths: string[] = []
  const queue: string[] = ['']
  while (queue.length > 0 && paths.length < limit) {
    const relative = queue.shift() as string
    let entries: Dirent<string>[]
    try {
      entries = await readdir(relative ? join(root, relative) : root, { withFileTypes: true, encoding: 'utf8' })
    } catch {
      continue
    }
    for (const entry of entries) {
      const child = relative ? `${relative}/${entry.name}` : entry.name
      // Symbolic links are never followed: one link back up the tree would walk forever.
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        if (!UNWALKED_DIRECTORIES.has(entry.name)) queue.push(child)
        continue
      }
      if (!entry.isFile()) continue
      if (paths.length === limit) break
      paths.push(child)
    }
  }
  return { paths, truncated: paths.length >= limit && queue.length > 0 }
}

/**
 * Turns a flat list of file paths into what the picker offers: every file, plus every directory
 * on the way to one, each named once and sorted so a directory sits immediately above the files
 * it contains. Directories are offerable because narrowing to a folder is how a reader points at
 * a part of the tree they cannot yet name a file in.
 */
function toEntries(paths: readonly string[]): WorkspaceFileEntry[] {
  const directories = new Set<string>()
  const files: string[] = []
  for (const path of paths) {
    const normalized = path.replace(/\\/g, '/').replace(/^\.\//, '')
    if (!normalized) continue
    files.push(normalized)
    let cut = normalized.lastIndexOf('/')
    while (cut > 0) {
      directories.add(normalized.slice(0, cut))
      cut = normalized.lastIndexOf('/', cut - 1)
    }
  }
  return [
    ...[...directories].map((path): WorkspaceFileEntry => ({ path, directory: true })),
    ...files.map((path): WorkspaceFileEntry => ({ path, directory: false }))
  ].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

interface CacheEntry {
  readAt: number
  index: Promise<WorkspaceFileIndex>
}

/**
 * A bounded, cached listing of one working directory, so the composer's `@` picker can narrow a
 * repository on every keystroke without any keystroke costing a directory walk. Every read is
 * keyed on the resolved working directory a node was launched in - a worktree's index is its own,
 * never the checkout's - and failure is always an empty index rather than a rejected promise:
 * losing the completion is a far smaller thing than losing the composer.
 */
export function createWorkspaceFileIndex(options: WorkspaceFileIndexOptions = {}): WorkspaceFileIndexReader {
  const listTracked = options.listTracked ?? listWithGit
  const walk = options.walk ?? walkDirectory
  const now = options.now ?? Date.now
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
  const limit = options.limit ?? WORKSPACE_FILE_INDEX_LIMIT
  const cache = new Map<string, CacheEntry>()

  const build = async (root: string): Promise<WorkspaceFileIndex> => {
    try {
      const tracked = await listTracked(root, limit)
      if (tracked.ok) {
        const paths = tracked.paths ?? []
        return {
          root,
          entries: toEntries(paths.slice(0, limit)),
          truncated: paths.length > limit,
          gitignored: true
        }
      }
    } catch {
      // Falls through to the walk: a git that cannot run is the same situation as no repository.
    }
    try {
      const walked = await walk(root, limit)
      return { root, entries: toEntries(walked.paths), truncated: walked.truncated, gitignored: false }
    } catch {
      return { root, entries: [], truncated: false, gitignored: false }
    }
  }

  return {
    read(root: string): Promise<WorkspaceFileIndex> {
      if (!root) return Promise.resolve({ root, entries: [], truncated: false, gitignored: false })
      const cached = cache.get(root)
      // An in-flight read is shared rather than restarted, so the burst of keystrokes that opens
      // the picker cannot spawn one git process per character.
      if (cached && now() - cached.readAt < ttlMs) return cached.index
      const entry: CacheEntry = { readAt: now(), index: build(root) }
      cache.set(root, entry)
      return entry.index
    }
  }
}

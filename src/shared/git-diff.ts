/**
 * A diff node reviews what a checkout has changed against a recorded base: the worktree's
 * `baseRef`, or `HEAD` for the primary checkout. This is the vocabulary both processes agree on
 * and the pure readers of git's machine formats (`-z` separated name-status, numstat and
 * porcelain status, plus a unified diff). Nothing here runs git; `git-worktree.ts` does that
 * and hands the output here, so what a shape means is decided exactly once.
 */

/** How a diff node persists: which checkout it reviews and where it sits, never any git output. */
export interface WorkspaceDiffNode {
  id: string
  projectId: string
  /** The worktree reviewed; absent means the project's primary checkout against `HEAD`. */
  worktreeId?: string
  position: { x: number; y: number }
  width: number
  height: number
  /** The file whose hunks were open, relative to the checkout, so a restart reopens the same review. */
  selectedPath?: string
}

export type GitChangeStatus =
  'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'type-changed' | 'unmerged' | 'untracked'

export interface GitChangedFile {
  /** Relative to the checkout, forward slashes, exactly as git prints it. */
  path: string
  status: GitChangeStatus
  /** Where a renamed or copied file came from. */
  oldPath?: string
  added?: number
  deleted?: number
  /** Git cannot count lines in it; the per-file diff will say so rather than show hunks. */
  binary?: boolean
}

export interface GitDiffRequest {
  /** Checkout directory to run in. */
  path: string
  /** What the working tree is compared against. `HEAD` for the primary checkout. */
  baseRef: string
}

export type GitDiffSummary =
  | { ok: true; branch?: string; files: GitChangedFile[] }
  | { ok: false; reason: 'missing' | 'not-a-repository' | 'failed'; message: string }

export interface GitFileDiffRequest extends GitDiffRequest {
  file: GitChangedFile
}

export type GitDiffLineKind = 'context' | 'added' | 'removed'

export interface GitDiffLine {
  kind: GitDiffLineKind
  text: string
}

export interface GitDiffHunk {
  /** The `@@ … @@` line verbatim, including any function context git appended. */
  header: string
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: GitDiffLine[]
}

export interface ParsedUnifiedDiff {
  hunks: GitDiffHunk[]
  binary: boolean
}

export type GitFileDiff = ({ ok: true } & ParsedUnifiedDiff) | { ok: false; message: string }

const STATUS_BY_LETTER: Record<string, GitChangeStatus> = {
  A: 'added',
  M: 'modified',
  D: 'deleted',
  R: 'renamed',
  C: 'copied',
  T: 'type-changed',
  U: 'unmerged'
}

/** `-z` output is NUL-separated and NUL-terminated; the trailing empty field is not a record. */
function nulFields(stdout: string): string[] {
  const fields = stdout.split('\0')
  if (fields.at(-1) === '') fields.pop()
  return fields
}

/**
 * `git diff -z --name-status <base>`: one status field, then one path - two for renames and copies.
 * @internal exported for tests
 */
export function parseNameStatus(stdout: string): GitChangedFile[] {
  const fields = nulFields(stdout)
  const files: GitChangedFile[] = []
  for (let index = 0; index < fields.length;) {
    const letter = fields[index][0]
    const status = STATUS_BY_LETTER[letter] ?? 'modified'
    if (letter === 'R' || letter === 'C') {
      const oldPath = fields[index + 1]
      const path = fields[index + 2]
      if (path === undefined) break
      files.push({ path, status, oldPath })
      index += 3
    } else {
      const path = fields[index + 1]
      if (path === undefined) break
      files.push({ path, status })
      index += 2
    }
  }
  return files
}

export interface GitLineCounts {
  added: number
  deleted: number
  binary: boolean
}

/**
 * `git diff -z --numstat <base>`: `added TAB deleted TAB path`, or for a rename `added TAB deleted
 * TAB` followed by the old and new paths as two more fields. Binary files count as `-`.
 * @internal exported for tests
 */
export function parseNumstat(stdout: string): Map<string, GitLineCounts> {
  const counts = new Map<string, GitLineCounts>()
  const fields = nulFields(stdout)
  for (let index = 0; index < fields.length; index += 1) {
    const match = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(fields[index])
    if (!match) continue
    const binary = match[1] === '-'
    const entry = { added: binary ? 0 : Number(match[1]), deleted: binary ? 0 : Number(match[2]), binary }
    if (match[3]) {
      counts.set(match[3], entry)
    } else {
      // Rename: the record carries no path, the next two fields are old then new.
      const path = fields[index + 2]
      if (path !== undefined) counts.set(path, entry)
      index += 2
    }
  }
  return counts
}

/**
 * `git status --porcelain=v1 -z --untracked-files=all`: every entry is `XY path`, and a rename or
 * copy is followed by its origin as one more field, which must be skipped rather than read as an
 * entry of its own.
 * @internal exported for tests
 */
export function parseUntrackedPaths(stdout: string): string[] {
  const fields = nulFields(stdout)
  const untracked: string[] = []
  for (let index = 0; index < fields.length; index += 1) {
    const entry = fields[index]
    if (entry.length < 4) continue
    const code = entry.slice(0, 2)
    if (code === '??') untracked.push(entry.slice(3))
    if (code[0] === 'R' || code[0] === 'C' || code[1] === 'R' || code[1] === 'C') index += 1
  }
  return untracked
}

export interface GitFileListOutput {
  nameStatus: string
  numstat: string
  status: string
}

/** The one changed-file list a diff node shows, from the three commands that together describe it. */
export function changedFilesFromGit(output: GitFileListOutput): GitChangedFile[] {
  const counts = parseNumstat(output.numstat)
  const tracked = parseNameStatus(output.nameStatus).map<GitChangedFile>((file) => {
    const count = counts.get(file.path)
    return count ? { ...file, added: count.added, deleted: count.deleted, binary: count.binary } : file
  })
  const known = new Set(tracked.map((file) => file.path))
  const untracked = parseUntrackedPaths(output.status)
    .filter((path) => !known.has(path))
    .map<GitChangedFile>((path) => ({ path, status: 'untracked' }))
  return [...tracked, ...untracked].sort((a, b) => a.path.localeCompare(b.path))
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

/**
 * Reads a unified diff into hunks. Everything before the first `@@` is the file header; a
 * `Binary files … differ` line there means git found no text to show. The "no newline at end of
 * file" marker is git's note about the file, not a line of it, so it is dropped.
 */
export function parseUnifiedDiff(stdout: string): ParsedUnifiedDiff {
  const hunks: GitDiffHunk[] = []
  let binary = false
  let current: GitDiffHunk | null = null
  for (const raw of stdout.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    const header = HUNK_HEADER.exec(line)
    if (header) {
      current = {
        header: line,
        oldStart: Number(header[1]),
        oldLines: header[2] === undefined ? 1 : Number(header[2]),
        newStart: Number(header[3]),
        newLines: header[4] === undefined ? 1 : Number(header[4]),
        lines: []
      }
      hunks.push(current)
      continue
    }
    if (!current) {
      if (/^Binary files .* differ$/.test(line)) binary = true
      continue
    }
    if (line.startsWith('\\')) continue
    if (line.startsWith('+')) current.lines.push({ kind: 'added', text: line.slice(1) })
    else if (line.startsWith('-')) current.lines.push({ kind: 'removed', text: line.slice(1) })
    else if (line.startsWith(' ')) current.lines.push({ kind: 'context', text: line.slice(1) })
    else if (line === '') continue
    else current = null // A new `diff --git` header: this hunk is over.
  }
  return { hunks, binary }
}

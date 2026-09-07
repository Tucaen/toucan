import type { GitChangedFile, GitChangeStatus, GitDiffHunk, GitDiffSummary } from '../../shared/git-diff'
import type { FileOperationBlock, FileOperationLine } from './file-operation'

/**
 * The decisions behind the diff node, kept free of React so what the node shows is testable as
 * data: how a git hunk becomes one of the transcript's file-operation blocks, how a changed file is
 * labelled in the rail, and what the header says about the checkout under review.
 */

/** The rail's one-letter status (the letters `git status --short` uses) and its spoken name. */
const STATUS_PRESENTATION: Record<GitChangeStatus, { glyph: string; label: string }> = {
  added: { glyph: 'A', label: 'Added' },
  modified: { glyph: 'M', label: 'Modified' },
  deleted: { glyph: 'D', label: 'Deleted' },
  renamed: { glyph: 'R', label: 'Renamed' },
  copied: { glyph: 'C', label: 'Copied' },
  'type-changed': { glyph: 'T', label: 'Type changed' },
  unmerged: { glyph: 'U', label: 'Unmerged' },
  untracked: { glyph: '?', label: 'Untracked' }
}

export function diffStatusGlyph(status: GitChangeStatus): string {
  return STATUS_PRESENTATION[status].glyph
}

export function describeDiffStatus(status: GitChangeStatus): string {
  return STATUS_PRESENTATION[status].label
}

/** `+12 −3` for a counted file, nothing for a binary or untracked one git could not count. */
export function diffCountsLabel(file: GitChangedFile): string | undefined {
  if (file.binary || file.added === undefined || file.deleted === undefined) return undefined
  return `+${file.added} −${file.deleted}`
}

/**
 * One hunk as one block: git's own header is the label, every line carries the old and new
 * numbers its side has, and the absolute path lets the block's path row offer Open/Copy/Reveal.
 * Numbering walks each side independently from the hunk's declared starts, which is exactly what
 * a unified diff promises.
 */
export function hunkBlock(hunk: GitDiffHunk, absolutePath: string): FileOperationBlock {
  let oldNumber = hunk.oldStart
  let newNumber = hunk.newStart
  const lines = hunk.lines.map<FileOperationLine>((line) => {
    if (line.kind === 'removed') return { oldNumber: oldNumber++, text: line.text, tone: 'old' }
    if (line.kind === 'added') return { newNumber: newNumber++, text: line.text, tone: 'new' }
    return { oldNumber: oldNumber++, newNumber: newNumber++, text: line.text }
  })
  return { path: absolutePath, languagePath: absolutePath, label: hunk.header, lines }
}

/** The header's one-line account of the checkout: which branch, against what. */
export function describeDiffBase(summary: GitDiffSummary | null, fallbackLabel: string, baseRef: string): string {
  const branch = summary?.ok && summary.branch ? summary.branch : fallbackLabel
  return `${branch} against ${baseRef}`
}

/**
 * Which file the rail should show as open after a refresh: the one the reader had open if it is
 * still changed, otherwise nothing - a selection that silently jumped to another file would show
 * hunks the reader did not ask for.
 */
export function retainedSelection(
  files: readonly GitChangedFile[],
  selectedPath: string | undefined
): string | undefined {
  return selectedPath !== undefined && files.some((file) => file.path === selectedPath) ? selectedPath : undefined
}

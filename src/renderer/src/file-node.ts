import type { FileReadFailure, FileReadResult, FileWriteFailure } from '../../shared/file-view'

/**
 * The decisions behind the file node that are worth pinning down without a DOM: how a picked
 * relative path becomes the absolute one the node records, how a failure reads, and what an
 * unsaved edit does when the file changes underneath it.
 */

/**
 * What the node holds beyond the file on disk. `draft` is the editor's text only while it differs
 * from the file; `baseMtime` is the read the draft was made against, which a save hands to main so
 * an external change is refused rather than overwritten; `conflict` records that such a change has
 * already arrived and the reader has to choose between it and the draft.
 */
export interface FileEditState {
  draft: string | null
  baseMtime: string | null
  conflict: boolean
}

export const UNEDITED: FileEditState = { draft: null, baseMtime: null, conflict: false }

export function isDirty(state: FileEditState): boolean {
  return state.draft !== null
}

/**
 * A fresh read of the file arrived - on mount, after the watcher reported a change, or after a
 * save. Without a draft it simply becomes the new base. With one, the read is either the node's
 * own save (same `mtime`, nothing to do) or somebody else's write, which is a conflict: the draft
 * is kept, because it is the only copy of the reader's work, and the choice is surfaced instead.
 */
export function editStateAfterRead(state: FileEditState, read: FileReadResult): FileEditState {
  if (state.draft === null) return { draft: null, baseMtime: read.ok ? read.mtime : null, conflict: false }
  if (read.ok && read.mtime === state.baseMtime) return state
  return state.conflict ? state : { ...state, conflict: true }
}

/** The editor's text changed. Typing the file back to what is on disk is not an edit. */
export function editStateAfterEdit(
  state: FileEditState,
  text: string,
  disk: { content: string; mtime: string }
): FileEditState {
  if (text === disk.content) return { draft: null, baseMtime: disk.mtime, conflict: false }
  return { draft: text, baseMtime: state.baseMtime ?? disk.mtime, conflict: state.conflict }
}

/**
 * A save went through. `saved` is the text that was written; `current` is the editor's text now,
 * which may already differ if the reader kept typing while the write was in flight - those
 * keystrokes are a new draft based on the saved file, never lost.
 */
export function editStateAfterSave(mtime: string, saved: string, current: string | null): FileEditState {
  if (current !== null && current !== saved) return { draft: current, baseMtime: mtime, conflict: false }
  return { draft: null, baseMtime: mtime, conflict: false }
}

/** Main refused the save because disk moved on: the same conflict the watcher would have raised. */
export function editStateAfterRefusedSave(state: FileEditState): FileEditState {
  return state.conflict ? state : { ...state, conflict: true }
}

/**
 * The reader chose the draft over the external change: rebase on the disk's mtime so the next
 * save is accepted, and stop asking. Nothing is written until they save.
 */
export function keepDraftOverDisk(state: FileEditState, disk: FileReadResult): FileEditState {
  return { draft: state.draft, baseMtime: disk.ok ? disk.mtime : null, conflict: false }
}

export type FileEditability =
  | { editable: true }
  | {
      editable: false
      /**
       * `truncated` matters most: saving a view that shows only the first megabyte would write
       * that megabyte back as the whole file.
       */
      reason: 'unavailable' | 'binary' | 'truncated'
    }

/** Whether the node may offer to edit what it shows; only a whole text file is safe to write back. */
export function fileEditability(result: FileReadResult | null): FileEditability {
  if (!result || !result.ok) return { editable: false, reason: 'unavailable' }
  if (result.binary) return { editable: false, reason: 'binary' }
  if (result.truncated) return { editable: false, reason: 'truncated' }
  return { editable: true }
}

export function describeFileWriteFailure(reason: FileWriteFailure, message: string): string {
  switch (reason) {
    case 'conflict':
      return 'This file changed on disk while you were editing. Reload it or keep your edits, then save again.'
    case 'not-found':
      return 'This file is not on disk any more, so your edit was not saved. Copy your text before closing the node.'
    case 'outside-workspace':
      return 'This file is outside every project and worktree in the workspace, so Toucan does not write it.'
    case 'directory':
      return 'This path is a folder, not a file.'
    case 'unwritable':
      return message || 'This file could not be written.'
  }
}

/**
 * The picker lists paths relative to a root with forward slashes, whatever the platform; the node
 * stores the absolute path in the root's own separator so Copy path yields something the reader
 * can paste into a Windows shell unchanged.
 */
export function joinWorkspacePath(root: string, relativePath: string): string {
  const separator = root.includes('\\') ? '\\' : '/'
  const trimmedRoot = root.replace(/[\\/]+$/, '')
  const segments = relativePath.split('/').filter(Boolean)
  return [trimmedRoot, ...segments].join(separator)
}

/**
 * Which project a file opened from a transcript card belongs to: the one whose checkout or
 * worktree contains it, and when roots nest, the deepest - a project inside another project's
 * folder owns its own files. Comparison is separator- and case-insensitive, like
 * `shortenFilePath`, because paths from adapters and from the snapshot differ in both.
 */
export function projectOwningPath(
  path: string,
  roots: readonly { projectId: string; root: string }[]
): string | undefined {
  const haystack = path.replace(/\\/g, '/').toLowerCase()
  let best: { projectId: string; length: number } | undefined
  for (const { projectId, root } of roots) {
    const prefix = root.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
    if (!prefix || !haystack.startsWith(`${prefix}/`)) continue
    if (!best || prefix.length > best.length) best = { projectId, length: prefix.length }
  }
  return best?.projectId
}

/** The file name alone, for the node's header. */
export function fileNodeName(path: string): string {
  const segments = path.replace(/\\/g, '/').split('/').filter(Boolean)
  return segments.at(-1) ?? path
}

export function describeFileReadFailure(reason: FileReadFailure, message: string): string {
  switch (reason) {
    case 'not-found':
      return 'This file is not on disk any more. The node stays so your layout does; close it when you are done.'
    case 'outside-workspace':
      return 'This file is outside every project and worktree in the workspace, so Toucan does not read it.'
    case 'directory':
      return 'This path is a folder, not a file.'
    case 'unreadable':
      return message || 'This file could not be read.'
  }
}

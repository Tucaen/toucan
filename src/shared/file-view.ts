/**
 * A file node shows one file from a project on the canvas and can save edits back to it. This is
 * the vocabulary both processes agree on: what a node persists, what a read or write returns, and
 * how the renderer reaches the file. Nothing here touches the filesystem.
 */

export type FileViewMode = 'rendered' | 'raw'

/** How a file node persists: geometry plus which way the reader last chose to look at the file. */
export interface WorkspaceFileNode {
  id: string
  projectId: string
  /** Absolute path of the file. Stays recorded even when the file has gone, so the layout survives. */
  path: string
  view: FileViewMode
  position: { x: number; y: number }
  width: number
  height: number
}

/**
 * How much of a file the node will show. Big enough for any document worth reading in a canvas
 * node, small enough that one read never stalls the main process or floods IPC.
 */
export const FILE_VIEW_MAX_BYTES = 1024 * 1024

export type FileReadFailure =
  /** The path resolves outside every registered project and worktree; read refused. */
  'outside-workspace' | 'not-found' | 'directory' | 'unreadable'

export type FileReadResult =
  | {
      ok: true
      /** UTF-8 text, cut at the byte cap when `truncated`; empty for a binary file. */
      content: string
      truncated: boolean
      /** Total size on disk in bytes, so a truncated view can say how much it left out. */
      size: number
      /** Last modification time as an ISO timestamp. */
      mtime: string
      /** The bytes do not read as text, so only the size is worth showing. */
      binary: boolean
    }
  | { ok: false; reason: FileReadFailure; message: string }

export type FileWriteFailure =
  /** The path resolves outside every registered project and worktree; write refused. */
  | 'outside-workspace'
  /** The file on disk is not the one the edit was based on: disk is truth, so nothing was written. */
  | 'conflict'
  | 'not-found'
  | 'directory'
  | 'unwritable'

export interface FileWriteRequest {
  path: string
  /** The whole file, UTF-8. A node never writes part of a file. */
  content: string
  /**
   * The `mtime` of the read the edit was made against. The write is refused as a `conflict` when
   * the file on disk has a different one, so an external change is never overwritten silently.
   */
  baseMtime: string
}

export type FileWriteResult =
  | {
      ok: true
      /** The written file's modification time, the base for the next edit. */
      mtime: string
      size: number
    }
  | { ok: false; reason: FileWriteFailure; message: string }

export interface FileViewApi {
  read(path: string): Promise<FileReadResult>
  /** Replaces the file's content atomically; main decides whether the path may be written at all. */
  write(request: FileWriteRequest): Promise<FileWriteResult>
  /** Starts telling this window when the file changes on disk. Idempotent per window and path. */
  watch(path: string): Promise<void>
  unwatch(path: string): Promise<void>
  onChange(callback: (path: string) => void): () => void
}

export function isFileViewMode(value: unknown): value is FileViewMode {
  return value === 'rendered' || value === 'raw'
}

export function isMarkdownPath(path: string): boolean {
  return /\.(md|markdown)$/i.test(path)
}

/** Markdown opens rendered because that is what it is for; anything else has only a raw view. */
export function defaultFileViewMode(path: string): FileViewMode {
  return isMarkdownPath(path) ? 'rendered' : 'raw'
}

/**
 * Paths on either side of the IPC boundary may differ in separators and, on Windows, in case;
 * a watcher's event and a node's path must still be recognised as the same file.
 */
export function fileViewPathIdentity(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

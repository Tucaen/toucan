import { watch } from 'node:fs'
import { open, stat } from 'node:fs/promises'
import { basename, dirname, relative, resolve, isAbsolute } from 'node:path'
import { FILE_VIEW_MAX_BYTES, fileViewPathIdentity, type FileReadResult } from '../shared/file-view'

const DEFAULT_DEBOUNCE_MS = 100

/** How many leading bytes decide whether a file is text: a NUL in them means it is not. */
const BINARY_PROBE_BYTES = 8 * 1024

export interface FileViewOwner {
  isDestroyed(): boolean
  send(channel: string, path: string): void
}

interface DirectoryWatcher {
  close(): void
  on?(event: 'error', listener: (error: Error) => void): unknown
}

type WatchDirectory = (
  path: string,
  listener: (eventType: string, filename: string | Buffer | null) => void
) => DirectoryWatcher

export interface FileView {
  read(path: string): Promise<FileReadResult>
  watch(path: string, owner: FileViewOwner): Promise<void>
  unwatch(path: string, owner: FileViewOwner): void
  disconnectOwner(owner: FileViewOwner): void
  shutdown(): void
}

export interface FileViewOptions {
  /**
   * The directories a file may be read from: every registered project checkout and every
   * worktree. Read per call rather than cached, so a project added a moment ago is readable.
   */
  roots(): readonly string[] | Promise<readonly string[]>
  maxBytes?: number
  debounceMs?: number
  /** Windows compares paths case-insensitively; the default follows the platform. */
  caseInsensitivePaths?: boolean
  watchDirectory?: WatchDirectory
}

interface FileWatch {
  path: string
  directory: string
  watcher: DirectoryWatcher
  owners: Set<FileViewOwner>
  timer?: NodeJS.Timeout
}

/**
 * The renderer's only way to read a file's bytes, and it fails closed: a path is readable only when
 * it resolves inside a registered project or worktree, so a hand-edited snapshot or a stray link
 * cannot turn a canvas node into a reader of arbitrary files. Reads are capped rather than
 * refused past the cap, because a truncated view of a huge log is still useful; a binary file is
 * reported as such instead of being decoded into noise.
 *
 * Changes are watched through the file's directory, not the file itself: editors and agents
 * replace a file by writing a temporary and renaming it over, which a watch on the old inode
 * would miss. Events are coalesced per file, since one save is several raw events.
 */
export function createFileView(options: FileViewOptions): FileView {
  const maxBytes = options.maxBytes ?? FILE_VIEW_MAX_BYTES
  const caseInsensitive = options.caseInsensitivePaths ?? process.platform === 'win32'
  const watchDirectory: WatchDirectory = options.watchDirectory ?? ((path, listener) => watch(path, listener))
  const watches = new Map<string, FileWatch>()
  let stopped = false

  const comparable = (path: string): string => {
    const resolved = resolve(path)
    return caseInsensitive ? resolved.toLowerCase() : resolved
  }

  const insideWorkspace = async (path: string): Promise<boolean> => {
    const target = comparable(path)
    for (const root of await options.roots()) {
      const between = relative(comparable(root), target)
      if (between && !between.startsWith('..') && !isAbsolute(between)) return true
    }
    return false
  }

  const read = async (path: string): Promise<FileReadResult> => {
    if (!(await insideWorkspace(path))) {
      return {
        ok: false,
        reason: 'outside-workspace',
        message: 'This file is outside every project and worktree in the workspace, so it is not shown.'
      }
    }
    const resolved = resolve(path)
    let handle
    try {
      const info = await stat(resolved)
      if (info.isDirectory()) {
        return { ok: false, reason: 'directory', message: 'This path is a folder, not a file.' }
      }
      handle = await open(resolved, 'r')
      try {
        const size = info.size
        const wanted = Math.min(size, maxBytes)
        const buffer = Buffer.alloc(wanted)
        let filled = 0
        while (filled < wanted) {
          const { bytesRead } = await handle.read(buffer, filled, wanted - filled, filled)
          if (bytesRead === 0) break
          filled += bytesRead
        }
        const bytes = buffer.subarray(0, filled)
        const binary = bytes.subarray(0, BINARY_PROBE_BYTES).includes(0)
        return {
          ok: true,
          content: binary ? '' : bytes.toString('utf8'),
          truncated: size > maxBytes,
          size,
          mtime: info.mtime.toISOString(),
          binary
        }
      } finally {
        await handle.close()
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        return { ok: false, reason: 'not-found', message: 'This file is not on disk any more.' }
      }
      return { ok: false, reason: 'unreadable', message: (error as Error).message }
    }
  }

  const release = (key: string): void => {
    const entry = watches.get(key)
    if (!entry) return
    if (entry.timer) clearTimeout(entry.timer)
    entry.watcher.close()
    watches.delete(key)
  }

  const publish = (key: string): void => {
    const entry = watches.get(key)
    if (!entry) return
    entry.timer = undefined
    for (const owner of entry.owners) {
      if (owner.isDestroyed()) entry.owners.delete(owner)
      else owner.send('file-view:changed', entry.path)
    }
    if (entry.owners.size === 0) release(key)
  }

  const schedule = (key: string): void => {
    const entry = watches.get(key)
    if (!entry) return
    if (entry.timer) clearTimeout(entry.timer)
    const timer = setTimeout(() => publish(key), options.debounceMs ?? DEFAULT_DEBOUNCE_MS)
    timer.unref()
    entry.timer = timer
  }

  return {
    read,
    watch: async (path, owner) => {
      if (stopped || !(await insideWorkspace(path))) return
      const resolved = resolve(path)
      const key = fileViewPathIdentity(resolved)
      const existing = watches.get(key)
      if (existing) {
        existing.owners.add(owner)
        return
      }
      const directory = dirname(resolved)
      const name = basename(resolved)
      const sameName = (candidate: string): boolean =>
        caseInsensitive ? candidate.toLowerCase() === name.toLowerCase() : candidate === name
      try {
        const watcher = watchDirectory(directory, (_eventType, filename) => {
          // A missing filename means the platform cannot say which entry changed, so refresh anyway.
          const changed = filename?.toString()
          if (changed === undefined || sameName(changed)) schedule(key)
        })
        // A folder deleted under a live watcher stops reporting; that must not take Toucan down.
        watcher.on?.('error', () => {})
        watches.set(key, { path: resolved, directory, watcher, owners: new Set([owner]) })
      } catch {
        // The directory is gone or unwatchable: the node still shows its not-found body on read.
      }
    },
    unwatch: (path, owner) => {
      const key = fileViewPathIdentity(resolve(path))
      const entry = watches.get(key)
      if (!entry) return
      entry.owners.delete(owner)
      if (entry.owners.size === 0) release(key)
    },
    disconnectOwner: (owner) => {
      for (const [key, entry] of watches) {
        entry.owners.delete(owner)
        if (entry.owners.size === 0) release(key)
      }
    },
    shutdown: () => {
      stopped = true
      for (const key of [...watches.keys()]) release(key)
    }
  }
}

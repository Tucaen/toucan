import { watch } from 'node:fs'
import { open, realpath, rename, stat, unlink } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, isAbsolute } from 'node:path'
import {
  FILE_VIEW_MAX_BYTES,
  type FileReadResult,
  type FileWriteRequest,
  type FileWriteResult
} from '../shared/file-view'

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
  write(request: FileWriteRequest): Promise<FileWriteResult>
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
  watcher: DirectoryWatcher
  timer?: NodeJS.Timeout
}

/**
 * The renderer's only way to read a file's bytes, and it fails closed: a path is readable only when
 * it resolves inside a registered project or worktree, so a hand-edited snapshot or a stray link
 * cannot turn a canvas node into a reader of arbitrary files. Reads are capped rather than
 * refused past the cap, because a truncated view of a huge log is still useful; a binary file is
 * reported as such instead of being decoded into noise.
 *
 * Writes go through the same guard and replace the file atomically - a temporary beside it,
 * fsynced, renamed over - so a crash mid-save leaves the old file rather than a torn one. A save
 * is refused as a conflict when the file's modification time is not the one the edit was based
 * on: disk is truth, and the node shows the external change rather than overwriting it.
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
  /**
   * Who wants each file watched, counted per window: one window may show the same file in two
   * nodes, and closing one must not blind the other. Recorded synchronously at `watch()` so an
   * `unwatch()` that lands while the roots are still being checked is not lost.
   */
  const holders = new Map<string, Map<FileViewOwner, number>>()
  let stopped = false

  const comparable = (path: string): string => (caseInsensitive ? path.toLowerCase() : path)

  /** The path as the filesystem knows it, so a link inside a checkout cannot point a read outside. */
  const realPathOf = (path: string): Promise<string> => realpath(path).catch(() => resolve(path))

  const insideWorkspace = async (path: string): Promise<boolean> => {
    const target = comparable(await realPathOf(resolve(path)))
    for (const root of await options.roots()) {
      const between = relative(comparable(await realPathOf(resolve(root))), target)
      if (between && !between.startsWith('..') && !isAbsolute(between)) return true
    }
    return false
  }

  const watchKey = (path: string): string => comparable(resolve(path))

  const hold = (key: string, owner: FileViewOwner, delta: 1 | -1): void => {
    const byOwner = holders.get(key) ?? new Map<FileViewOwner, number>()
    const count = (byOwner.get(owner) ?? 0) + delta
    if (count > 0) byOwner.set(owner, count)
    else byOwner.delete(owner)
    if (byOwner.size > 0) holders.set(key, byOwner)
    else holders.delete(key)
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

  const write = async ({ path, content, baseMtime }: FileWriteRequest): Promise<FileWriteResult> => {
    if (!(await insideWorkspace(path))) {
      return {
        ok: false,
        reason: 'outside-workspace',
        message: 'This file is outside every project and worktree in the workspace, so it is not written.'
      }
    }
    const resolved = resolve(path)
    let current
    try {
      current = await stat(resolved)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        return {
          ok: false,
          reason: 'not-found',
          message: 'This file is not on disk any more, so the edit was not saved.'
        }
      }
      return { ok: false, reason: 'unwritable', message: (error as Error).message }
    }
    if (current.isDirectory()) {
      return { ok: false, reason: 'directory', message: 'This path is a folder, not a file.' }
    }
    if (current.mtime.toISOString() !== baseMtime) {
      return {
        ok: false,
        reason: 'conflict',
        message: 'This file changed on disk while you were editing it, so your version was not written over it.'
      }
    }
    const temporary = join(dirname(resolved), `.${basename(resolved)}.${process.pid}.${Date.now()}.tmp`)
    try {
      const handle = await open(temporary, 'w', current.mode)
      try {
        await handle.writeFile(content, 'utf8')
        await handle.sync()
      } finally {
        await handle.close()
      }
      await rename(temporary, resolved)
    } catch (error) {
      await unlink(temporary).catch(() => {})
      return { ok: false, reason: 'unwritable', message: (error as Error).message }
    }
    const written = await stat(resolved)
    return { ok: true, mtime: written.mtime.toISOString(), size: written.size }
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
    for (const owner of [...(holders.get(key)?.keys() ?? [])]) {
      if (owner.isDestroyed()) holders.get(key)?.delete(owner)
      else owner.send('file-view:changed', entry.path)
    }
    if (!holders.get(key)?.size) {
      holders.delete(key)
      release(key)
    }
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
    write,
    watch: async (path, owner) => {
      if (stopped) return
      const resolved = resolve(path)
      const key = watchKey(resolved)
      hold(key, owner, 1)
      if (!(await insideWorkspace(resolved))) {
        hold(key, owner, -1)
        return
      }
      // Released while the roots were being read, or shut down: nothing left to watch for.
      if (stopped || !holders.get(key)?.has(owner) || watches.has(key)) return
      const name = basename(resolved)
      const sameName = (candidate: string): boolean => comparable(candidate) === comparable(name)
      try {
        const watcher = watchDirectory(dirname(resolved), (_eventType, filename) => {
          // A missing filename means the platform cannot say which entry changed, so refresh anyway.
          const changed = filename?.toString()
          if (changed === undefined || sameName(changed)) schedule(key)
        })
        // A folder deleted under a live watcher stops reporting; that must not take Toucan down.
        watcher.on?.('error', () => {})
        watches.set(key, { path: resolved, watcher })
      } catch {
        // The directory is gone or unwatchable: the node still shows its not-found body on read.
        hold(key, owner, -1)
      }
    },
    unwatch: (path, owner) => {
      const key = watchKey(path)
      hold(key, owner, -1)
      if (!holders.has(key)) release(key)
    },
    disconnectOwner: (owner) => {
      for (const [key, byOwner] of holders) {
        byOwner.delete(owner)
        if (byOwner.size === 0) {
          holders.delete(key)
          release(key)
        }
      }
    },
    shutdown: () => {
      stopped = true
      holders.clear()
      for (const key of [...watches.keys()]) release(key)
    }
  }
}

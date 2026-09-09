import { open, realpath, rename, stat, unlink } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, isAbsolute } from 'node:path'
import { FILE_VIEW_CHANNELS } from '../shared/ipc-channels'
import {
  FILE_VIEW_MAX_BYTES,
  type FileReadResult,
  type FileWriteRequest,
  type FileWriteResult
} from '../shared/file-view'
import { createWatchedDirectories, type WatchDirectory } from './watched-directories'

/** How many leading bytes decide whether a file is text: a NUL in them means it is not. */
const BINARY_PROBE_BYTES = 8 * 1024

export interface FileViewOwner {
  isDestroyed(): boolean
  send(channel: string, path: string): void
}

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
 * would miss. The debounce and holder bookkeeping live in the shared `watched-directories`
 * mechanism; this module keeps the policy - what counts as the watched file's own change, and
 * that a file nobody holds any more is released.
 */
export function createFileView(options: FileViewOptions): FileView {
  const maxBytes = options.maxBytes ?? FILE_VIEW_MAX_BYTES
  const caseInsensitive = options.caseInsensitivePaths ?? process.platform === 'win32'
  /**
   * Holds are counted per window: one window may show the same file in two nodes, and closing one
   * must not blind the other. A hold is recorded synchronously at `watch()` so an `unwatch()` that
   * lands while the roots are still being checked is not lost, and a key's last holder leaving -
   * however it leaves - closes the OS watch handle.
   */
  const watches = createWatchedDirectories({
    channel: FILE_VIEW_CHANNELS.changed,
    debounceMs: options.debounceMs,
    watchDirectory: options.watchDirectory,
    onUnheld: (key) => watches.close(key)
  })
  let stopped = false

  const comparable = (path: string): string => (caseInsensitive ? path.toLowerCase() : path)

  /**
   * The path as the filesystem knows it, so a link inside a checkout cannot point a read outside.
   *
   * `realpath` only answers for a path that already exists, and the paths that matter most here
   * often do not: a file that was deleted under the node, or a name a save is about to create. So
   * the deepest ancestor that *does* exist is canonicalized and the rest re-attached, which keeps
   * both sides of the containment check in the same form. Comparing a canonical root against a
   * literal target reads as climbing out of the workspace whenever a project is reached through a
   * junction, a symlink or an 8.3 short path - and, the other way round, it used to let a write to
   * a not-yet-existing name through a link that leaves the workspace entirely.
   */
  const realPathOf = async (path: string): Promise<string> => {
    let head = resolve(path)
    const tail: string[] = []
    for (;;) {
      try {
        return join(await realpath(head), ...tail)
      } catch {
        const parent = dirname(head)
        // A filesystem root that does not resolve leaves nothing above it to ask about.
        if (parent === head) return resolve(path)
        tail.unshift(basename(head))
        head = parent
      }
    }
  }

  const insideWorkspace = async (path: string): Promise<boolean> => {
    const target = comparable(await realPathOf(resolve(path)))
    for (const root of await options.roots()) {
      const between = relative(comparable(await realPathOf(resolve(root))), target)
      if (between && !between.startsWith('..') && !isAbsolute(between)) return true
    }
    return false
  }

  const watchKey = (path: string): string => comparable(resolve(path))

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
    // Write the file the guard validated: through a link, that is the target, so a save never
    // turns a symlink in the checkout into a regular file.
    const resolved = await realPathOf(resolve(path))
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

  return {
    read,
    write,
    watch: async (path, owner) => {
      if (stopped) return
      const resolved = resolve(path)
      const key = watchKey(resolved)
      watches.hold(key, owner)
      if (!(await insideWorkspace(resolved))) {
        watches.unhold(key, owner)
        return
      }
      // Released while the roots were being read, or shut down: nothing left to watch for.
      if (stopped || !watches.isHeldBy(key, owner) || watches.has(key)) return
      const name = basename(resolved)
      try {
        watches.open(key, {
          directory: dirname(resolved),
          payload: resolved,
          matches: (candidate) => comparable(candidate) === comparable(name)
        })
      } catch {
        // The directory is gone or unwatchable: the node still shows its not-found body on read.
        watches.unhold(key, owner)
      }
    },
    unwatch: (path, owner) => watches.unhold(watchKey(path), owner),
    disconnectOwner: (owner) => watches.disconnectOwner(owner),
    shutdown: () => {
      stopped = true
      watches.shutdown()
    }
  }
}

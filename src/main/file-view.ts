import { open, rename, stat, unlink } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { FILE_VIEW_CHANNELS } from '../shared/ipc-channels'
import {
  FILE_VIEW_MAX_BYTES,
  type FileReadResult,
  type FileWriteRequest,
  type FileWriteResult
} from '../shared/file-view'
import { applyLineEnding, dominantLineEnding } from '../shared/line-endings'
import { createWatchedDirectories, type WatchDirectory } from './watched-directories'
import { createWorkspaceContainment, type WorkspaceContainmentOptions } from './workspace-containment'
import type { FileFormatResult, FileFormatter } from './file-formatter'

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

/**
 * `roots` and the case rule come from `WorkspaceContainmentOptions`: what a file node may read is
 * the workspace containment question, and this module only adds how much it reads and how it
 * watches.
 */
export interface FileViewOptions extends WorkspaceContainmentOptions {
  maxBytes?: number
  debounceMs?: number
  watchDirectory?: WatchDirectory
  /** Optional format-on-save policy supplied by the composition root. */
  formatter?: FileFormatter
}

/**
 * The renderer's only way to read a file's bytes, and it fails closed through the shared
 * `workspace-containment` rule: a path is readable only when it resolves inside a registered
 * project or worktree, so a hand-edited snapshot or a stray link cannot turn a canvas node into a
 * reader of arbitrary files. Reads are capped rather than refused past the cap, because a
 * truncated view of a huge log is still useful; a binary file is reported as such instead of
 * being decoded into noise.
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
  const { comparable, realPathOf, contains: insideWorkspace } = createWorkspaceContainment(options)
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
        const text = binary ? '' : bytes.toString('utf8')
        const lineEnding = dominantLineEnding(text)
        return {
          ok: true,
          // Text travels as LF and `lineEnding` says what disk speaks. The editor cannot hold the
          // distinction anyway, and handing it the raw bytes made every CRLF file read as edited:
          // the draft it gives back has LF endings and would never compare equal to disk again.
          content: applyLineEnding(text, 'lf'),
          lineEnding,
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

  const write = async ({ path, content, baseMtime, lineEnding }: FileWriteRequest): Promise<FileWriteResult> => {
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
    // The file keeps the line ending it was read with. Both halves are needed: the formatter is
    // told, so a project configuration saying `endOfLine` cannot convert the file behind the
    // reader's back, and the result is converted anyway, because an unsupported or unformatted
    // file arrives from the editor with every line ending already flattened to LF.
    const ending = lineEnding ?? dominantLineEnding(content)
    let formatted: FileFormatResult = { content }
    try {
      if (options.formatter) formatted = await options.formatter(path, content, ending)
    } catch (error) {
      formatted = { content, warning: (error as Error).message }
    }
    const output = applyLineEnding(formatted.content, ending)
    const asRead = applyLineEnding(formatted.content, 'lf')
    // Formatting is asynchronous and makes the old stat-to-rename race large enough to matter.
    // Re-check the base immediately before creating the replacement so formatter work can never
    // give an external writer a window in which its newer contents are silently overwritten.
    let beforeWrite
    try {
      beforeWrite = await stat(resolved)
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
    if (beforeWrite.mtime.toISOString() !== baseMtime) {
      return {
        ok: false,
        reason: 'conflict',
        message: 'This file changed on disk while you were editing it, so your version was not written over it.'
      }
    }
    const temporary = join(dirname(resolved), `.${basename(resolved)}.${process.pid}.${Date.now()}.tmp`)
    try {
      const handle = await open(temporary, 'w', beforeWrite.mode)
      try {
        await handle.writeFile(output, 'utf8')
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
    return {
      ok: true,
      mtime: written.mtime.toISOString(),
      size: written.size,
      content: asRead,
      formatWarning: formatted.warning
    }
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

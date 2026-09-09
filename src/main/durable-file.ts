/**
 * The one home of durable file writes in main. Everything that persists by writing a temp file and
 * renaming it over the target goes through here, so fsync and rename semantics - and the cleanup a
 * failed write owes - are fixed in one place. Stores with a richer protocol (`workspace-store`'s
 * backup promotion, `terminal-scrollback-store`'s pending marker) compose these primitives rather
 * than reimplementing them.
 */
import { closeSync, constants, fsyncSync, openSync, renameSync, unlinkSync, writeSync } from 'node:fs'
import { access, open, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'

export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}

/** Best-effort removal of a temp file after a failed write; the failure itself is what the caller reports. */
export function discardTempFileSync(path: string): void {
  try {
    unlinkSync(path)
  } catch {
    // Nothing temporary survived, or it is stuck; either way the write's own error is what matters.
  }
}

export async function writeNewFileDurably(path: string, contents: string): Promise<void> {
  // A failed exclusive open owns nothing: cleaning up here would delete the very file
  // this function just refused to replace.
  const handle = await open(path, 'wx')
  try {
    try {
      await handle.writeFile(contents, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
  } catch (error) {
    await rm(path, { force: true }).catch(() => {})
    throw error
  }
}

/** Flushes the promoted file and, where the platform supports it, its containing directory entry. */
export async function syncPromotedFile(path: string, directory: string): Promise<void> {
  const file = await open(path, 'r+')
  try {
    await file.sync()
  } finally {
    await file.close()
  }
  if (process.platform === 'win32') return
  const parent = await open(directory, 'r')
  try {
    await parent.sync()
  } finally {
    await parent.close()
  }
}

/** Writes `contents` fully and durably to `tempPath`, unlinking it again on any failure. */
export async function writeFileDurably(tempPath: string, contents: string): Promise<void> {
  try {
    const handle = await open(tempPath, 'w')
    try {
      await handle.writeFile(contents, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
  } catch (error) {
    discardTempFileSync(tempPath)
    throw error
  }
}

/** Writes `contents` fully and durably to a temp file, then atomically renames it onto `targetPath`. */
export async function writeSnapshotAtomically(targetPath: string, contents: string): Promise<void> {
  const tempPath = `${targetPath}.tmp-${randomUUID()}`
  await writeFileDurably(tempPath, contents)
  try {
    renameSync(tempPath, targetPath)
  } catch (error) {
    discardTempFileSync(tempPath)
    throw error
  }
}

/**
 * The synchronous `writeSnapshotAtomically`, for the writes that cannot await (`before-quit`, the
 * pre-window remote-access read/write path). `durable` decides whether the temp file is fsynced
 * before the rename: a credential or a shutdown verdict wants the barrier, while a per-output-chunk
 * write like terminal scrollback would pay it on every keystroke's worth of output.
 */
export function writeSnapshotAtomicallySync(targetPath: string, contents: string, options: { durable: boolean }): void {
  const tempPath = `${targetPath}.tmp-${randomUUID()}`
  try {
    const handle = openSync(tempPath, 'w')
    try {
      writeSync(handle, contents, null, 'utf8')
      if (options.durable) fsyncSync(handle)
    } finally {
      closeSync(handle)
    }
    renameSync(tempPath, targetPath)
  } catch (error) {
    discardTempFileSync(tempPath)
    throw error
  }
}

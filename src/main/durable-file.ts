/**
 * The one home of durable file writes in main. Everything that persists by writing a temp file and
 * renaming it over the target goes through here, so fsync and rename semantics - and the cleanup a
 * failed write owes - are fixed in one place. Stores with a richer protocol (`workspace-store`'s
 * backup promotion, `terminal-scrollback-store`'s pending marker) compose these primitives rather
 * than reimplementing them.
 */
import { closeSync, constants, fsyncSync, openSync, renameSync, unlinkSync, writeSync } from 'node:fs'
import { access, mkdir, open, rename, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'

export interface DurableWriteOptions {
  /** Mode for the file being created, for a promotion that has to preserve the target's permissions. */
  mode?: number
  /**
   * How the finished temp file becomes the destination; a replacing rename by default. The two
   * shapes that need their own are a move that must refuse an existing destination and a rewrite
   * that must replace one.
   */
  promote?: (temporaryPath: string, destinationPath: string) => Promise<void>
}

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

export async function writeNewFileDurably(path: string, contents: string | Uint8Array, mode?: number): Promise<void> {
  // A failed exclusive open owns nothing: cleaning up here would delete the very file
  // this function just refused to replace.
  const handle = await open(path, 'wx', mode)
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

/**
 * Flushes the directory entry a promotion just created. The bytes need no second flush: they were
 * fsynced on the temp file's own handle before the rename, and reopening the *destination* to say
 * so again is how a preserved read-only `mode` turned a write that had already landed into an
 * `EPERM` the caller reported as a failed save. Windows exposes no directory handle to flush.
 */
async function syncPromotedDirectory(directory: string): Promise<void> {
  if (process.platform === 'win32') return
  const parent = await open(directory, 'r')
  try {
    await parent.sync()
  } finally {
    await parent.close()
  }
}

/** Writes `contents` fully and durably to `tempPath`, unlinking it again on any failure. */
export async function writeFileDurably(tempPath: string, contents: string | Uint8Array, mode?: number): Promise<void> {
  try {
    const handle = await open(tempPath, 'w', mode)
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

/** What Windows answers a replacing rename with while another handle holds the destination open. */
const HELD_DESTINATION_CODES = new Set(['EPERM', 'EACCES', 'EBUSY'])

/** Backoff between attempts: about 0.6 s in all, longer than a reader or a scanner holds a file. */
const HELD_DESTINATION_RETRY_MS = [10, 20, 40, 80, 160, 320]

/**
 * The default promotion: a replacing rename that outlasts a brief hold on the destination. Windows
 * refuses to rename over a file any other handle has open - an antivirus or indexer looking at a
 * file that was just written, or another reader of it - and reports that as `EPERM`/`EACCES`/
 * `EBUSY`, so a store whose writes land in quick succession lost one outright. The hold is over in
 * milliseconds, so the rename is retried briefly before the failure is the caller's to report.
 * Elsewhere those codes mean a real permission problem and fail at once.
 * @internal exported for tests
 */
export async function renameOverHeldDestination(
  temporaryPath: string,
  destinationPath: string,
  attempt: (from: string, to: string) => Promise<void> = rename,
  platform: NodeJS.Platform = process.platform
): Promise<void> {
  for (let retry = 0; ; retry += 1) {
    try {
      await attempt(temporaryPath, destinationPath)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code
      const wait = HELD_DESTINATION_RETRY_MS[retry]
      if (platform !== 'win32' || !code || !HELD_DESTINATION_CODES.has(code) || wait === undefined) throw error
      await delay(wait)
    }
  }
}

/**
 * The middle every promote-a-temp-file write shares: fill the temp file, hand it to `promote`, and
 * on a failure anywhere leave no temp file behind and the destination as it was found.
 */
async function promoteTemporary(
  temporaryPath: string,
  destinationPath: string,
  contents: string | Uint8Array,
  options: DurableWriteOptions
): Promise<void> {
  // Exclusive, so a temp path that somehow already exists is refused rather than truncated, and
  // `writeNewFileDurably` already cleans up after itself - only the promotion needs a guard here.
  await writeNewFileDurably(temporaryPath, contents, options.mode)
  try {
    await (options.promote ?? renameOverHeldDestination)(temporaryPath, destinationPath)
  } catch (error) {
    discardTempFileSync(temporaryPath)
    throw error
  }
}

/** Writes `contents` fully and durably to a temp file, then atomically renames it onto `targetPath`. */
export async function writeSnapshotAtomically(
  targetPath: string,
  contents: string | Uint8Array,
  options: DurableWriteOptions = {}
): Promise<void> {
  await promoteTemporary(`${targetPath}.tmp-${randomUUID()}`, targetPath, contents, options)
}

/**
 * `writeSnapshotAtomically` for the file *collections* - tickets, brain-dump topics - whose temp
 * file has to stay hidden from the folder listing and the watcher that reads it, whose folder may
 * not exist yet, and whose durability has to cover the directory entry as well as the bytes.
 */
export async function writeThroughTemporary(
  destinationPath: string,
  contents: string | Uint8Array,
  options: DurableWriteOptions = {}
): Promise<void> {
  const folder = dirname(destinationPath)
  await mkdir(folder, { recursive: true })
  const temporaryPath = join(folder, `.${basename(destinationPath)}.tmp-${randomUUID()}`)
  await promoteTemporary(temporaryPath, destinationPath, contents, options)
  await syncPromotedDirectory(folder)
}

/**
 * The synchronous `writeSnapshotAtomically`, for the writes that cannot await (`before-quit`, the
 * pre-window remote-access read/write path). `durable` decides whether the temp file is fsynced
 * before the rename: a credential or a shutdown verdict wants the barrier, while write-debounced
 * terminal scrollback deliberately trades the barrier for lower output-path latency.
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

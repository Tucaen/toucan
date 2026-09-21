import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { TerminalScrollbackSnapshot } from '../shared/terminal'
import { writeSnapshotAtomicallySync } from './durable-file'

export const TERMINAL_SCROLLBACK_MAX_BYTES = 512 * 1024
export const TERMINAL_SCROLLBACK_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
export const TERMINAL_SCROLLBACK_FLUSH_DELAY_MS = 100

interface StoredSnapshot extends TerminalScrollbackSnapshot {
  version: 1
}

export interface TerminalScrollbackStoreOptions {
  directory: string
  maxBytes?: number
  maxAgeMs?: number
  now?: () => number
  /** Injectable so tests can advance the debounce without waiting in real time. */
  schedule?: (run: () => void, delayMs: number) => { cancel(): void }
}

export interface TerminalScrollbackStore {
  begin(sessionId: string, incarnationId: string): void
  append(sessionId: string, incarnationId: string, data: string): void
  flush(sessionId: string, incarnationId: string): void
  load(sessionId: string): TerminalScrollbackSnapshot | null
  /** False means at least one retained file could not be deleted. */
  remove(sessionId: string): boolean
}

interface CachedSnapshot {
  snapshot: StoredSnapshot
  /** Tracked as chunks arrive so append never measures the whole retained string. */
  dataBytes: number
  dirty: boolean
}

function isStoredSnapshot(value: unknown): value is StoredSnapshot {
  if (!value || typeof value !== 'object') return false
  const snapshot = value as Partial<StoredSnapshot>
  return (
    snapshot.version === 1 &&
    typeof snapshot.sessionId === 'string' &&
    typeof snapshot.incarnationId === 'string' &&
    typeof snapshot.data === 'string' &&
    typeof snapshot.capturedAt === 'number' &&
    typeof snapshot.truncated === 'boolean' &&
    typeof snapshot.incomplete === 'boolean'
  )
}

/**
 * The largest valid UTF-8 suffix within a byte limit. Shared with `terminal-output-tail.ts`,
 * which caps its retained tail the same way: a limit that splits a character would hand its
 * reader a replacement character where the process emitted a letter.
 */
export function boundedUtf8Suffix(data: string, maxBytes: number): string {
  const bytes = Buffer.from(data, 'utf8')
  if (bytes.length <= maxBytes) return data
  let start = bytes.length - maxBytes
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start += 1
  return bytes.subarray(start).toString('utf8')
}

export function createTerminalScrollbackStore(options: TerminalScrollbackStoreOptions): TerminalScrollbackStore {
  const maxBytes = Math.max(0, options.maxBytes ?? TERMINAL_SCROLLBACK_MAX_BYTES)
  const maxAgeMs = Math.max(0, options.maxAgeMs ?? TERMINAL_SCROLLBACK_MAX_AGE_MS)
  const now = options.now ?? Date.now
  const schedule =
    options.schedule ??
    ((run: () => void, delayMs: number) => {
      const timer = setTimeout(run, delayMs)
      timer.unref()
      return { cancel: () => clearTimeout(timer) }
    })
  const snapshotsBySessionId = new Map<string, CachedSnapshot>()
  const scheduledFlushes = new Map<string, { incarnationId: string; cancel(): void }>()
  mkdirSync(options.directory, { recursive: true })

  const pathFor = (sessionId: string): string =>
    join(options.directory, `${createHash('sha256').update(sessionId).digest('hex')}.json`)
  const pendingPathFor = (sessionId: string): string => `${pathFor(sessionId)}.pending`

  const persist = (snapshot: StoredSnapshot): boolean => {
    const path = pathFor(snapshot.sessionId)
    const pendingPath = pendingPathFor(snapshot.sessionId)
    try {
      // This marker is written first. If promotion fails or Toucan stops between writes, the next
      // load can identify both the missing range and the incarnation it belonged to.
      writeFileSync(
        pendingPath,
        JSON.stringify({
          sessionId: snapshot.sessionId,
          incarnationId: snapshot.incarnationId
        }),
        'utf8'
      )
      // Not durable: this runs per output chunk, and an fsync here would tax terminal throughput.
      writeSnapshotAtomicallySync(path, JSON.stringify(snapshot), { durable: false })
      unlinkSync(pendingPath)
      return true
    } catch {
      return false
    }
  }

  const read = (sessionId: string): CachedSnapshot | null => {
    const cached = snapshotsBySessionId.get(sessionId)
    if (cached) return cached
    try {
      const parsed: unknown = JSON.parse(readFileSync(pathFor(sessionId), 'utf8'))
      if (!isStoredSnapshot(parsed) || parsed.sessionId !== sessionId) return null
      let pendingIncarnationId: string | undefined
      try {
        const pending = JSON.parse(readFileSync(pendingPathFor(sessionId), 'utf8')) as Record<string, unknown>
        if (pending.sessionId === sessionId && typeof pending.incarnationId === 'string') {
          pendingIncarnationId = pending.incarnationId
        }
      } catch {
        /* No valid pending write exists. */
      }
      // A newer incarnation began but did not replace the old snapshot. Never show the retired
      // incarnation under the durable session just because it was the last successful write.
      if (pendingIncarnationId && pendingIncarnationId !== parsed.incarnationId) return null
      const snapshot = pendingIncarnationId ? { ...parsed, incomplete: true } : parsed
      const entry = { snapshot, dataBytes: Buffer.byteLength(snapshot.data, 'utf8'), dirty: false }
      snapshotsBySessionId.set(sessionId, entry)
      return entry
    } catch {
      return null
    }
  }

  const cancelScheduledFlush = (sessionId: string): void => {
    scheduledFlushes.get(sessionId)?.cancel()
    scheduledFlushes.delete(sessionId)
  }

  const boundedSnapshot = (entry: CachedSnapshot): StoredSnapshot => {
    if (entry.dataBytes <= maxBytes) return entry.snapshot
    return {
      ...entry.snapshot,
      data: boundedUtf8Suffix(entry.snapshot.data, maxBytes),
      truncated: true,
      incomplete: true
    }
  }

  const flush = (sessionId: string, incarnationId: string): void => {
    const scheduled = scheduledFlushes.get(sessionId)
    if (scheduled?.incarnationId === incarnationId) cancelScheduledFlush(sessionId)
    const entry = snapshotsBySessionId.get(sessionId)
    if (!entry || entry.snapshot.incarnationId !== incarnationId || !entry.dirty) return
    const snapshot = boundedSnapshot(entry)
    const dataBytes = Buffer.byteLength(snapshot.data, 'utf8')
    if (persist(snapshot)) {
      snapshotsBySessionId.set(sessionId, { snapshot, dataBytes, dirty: false })
    } else {
      snapshotsBySessionId.set(sessionId, {
        snapshot: { ...snapshot, incomplete: true },
        dataBytes,
        dirty: true
      })
    }
  }

  const scheduleFlush = (sessionId: string, incarnationId: string): void => {
    if (scheduledFlushes.has(sessionId)) return
    const timer = schedule(() => {
      const scheduled = scheduledFlushes.get(sessionId)
      if (!scheduled || scheduled.incarnationId !== incarnationId) return
      scheduledFlushes.delete(sessionId)
      flush(sessionId, incarnationId)
    }, TERMINAL_SCROLLBACK_FLUSH_DELAY_MS)
    scheduledFlushes.set(sessionId, { incarnationId, cancel: timer.cancel })
  }

  return {
    begin(sessionId, incarnationId): void {
      cancelScheduledFlush(sessionId)
      const snapshot: StoredSnapshot = {
        version: 1,
        sessionId,
        incarnationId,
        data: '',
        capturedAt: now(),
        truncated: false,
        incomplete: false
      }
      snapshotsBySessionId.set(sessionId, { snapshot, dataBytes: 0, dirty: true })
      flush(sessionId, incarnationId)
    },
    append(sessionId, incarnationId, data): void {
      const existing = read(sessionId)
      if (!existing || existing.snapshot.incarnationId !== incarnationId) return
      const addedBytes = Buffer.byteLength(data, 'utf8')
      let combined = `${existing.snapshot.data}${data}`
      let combinedBytes = existing.dataBytes + addedBytes
      const wasTruncated = combinedBytes > maxBytes
      // Match the in-memory terminal tail: pay for a whole-buffer trim once per retention's worth
      // of output, rather than on every PTY chunk after the limit is first reached.
      if (combinedBytes > maxBytes * 2) {
        combined = boundedUtf8Suffix(combined, maxBytes)
        combinedBytes = Buffer.byteLength(combined, 'utf8')
      }
      const snapshot: StoredSnapshot = {
        ...existing.snapshot,
        data: combined,
        capturedAt: now(),
        truncated: existing.snapshot.truncated || wasTruncated,
        incomplete: existing.snapshot.incomplete || wasTruncated
      }
      snapshotsBySessionId.set(sessionId, { snapshot, dataBytes: combinedBytes, dirty: true })
      scheduleFlush(sessionId, incarnationId)
    },
    flush(sessionId, incarnationId): void {
      flush(sessionId, incarnationId)
    },
    load(sessionId): TerminalScrollbackSnapshot | null {
      const entry = read(sessionId)
      if (!entry) return null
      const snapshot = boundedSnapshot(entry)
      if (now() - snapshot.capturedAt > maxAgeMs) {
        cancelScheduledFlush(sessionId)
        snapshotsBySessionId.delete(sessionId)
        try {
          unlinkSync(pathFor(sessionId))
        } catch {
          /* Already absent or inaccessible. */
        }
        try {
          unlinkSync(pendingPathFor(sessionId))
        } catch {
          /* Already absent or inaccessible. */
        }
        return null
      }
      const { version: _version, ...publicSnapshot } = snapshot
      return publicSnapshot
    },
    remove(sessionId): boolean {
      cancelScheduledFlush(sessionId)
      snapshotsBySessionId.delete(sessionId)
      let removed = true
      for (const path of [pathFor(sessionId), pendingPathFor(sessionId)]) {
        if (!existsSync(path)) continue
        try {
          unlinkSync(path)
        } catch {
          removed = false
        }
      }
      return removed
    }
  }
}

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { TerminalScrollbackSnapshot } from '../shared/terminal'
import { writeSnapshotAtomicallySync } from './durable-file'

export const TERMINAL_SCROLLBACK_MAX_BYTES = 512 * 1024
export const TERMINAL_SCROLLBACK_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

interface StoredSnapshot extends TerminalScrollbackSnapshot {
  version: 1
}

export interface TerminalScrollbackStoreOptions {
  directory: string
  maxBytes?: number
  maxAgeMs?: number
  now?: () => number
}

export interface TerminalScrollbackStore {
  begin(sessionId: string, incarnationId: string): void
  append(sessionId: string, incarnationId: string, data: string): void
  load(sessionId: string): TerminalScrollbackSnapshot | null
  /** False means at least one retained file could not be deleted. */
  remove(sessionId: string): boolean
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

/** Returns the largest valid UTF-8 suffix within the byte limit. */
function boundedSuffix(data: string, maxBytes: number): string {
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
  const snapshotsBySessionId = new Map<string, StoredSnapshot>()
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

  const read = (sessionId: string): StoredSnapshot | null => {
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
      snapshotsBySessionId.set(sessionId, snapshot)
      return snapshot
    } catch {
      return null
    }
  }

  return {
    begin(sessionId, incarnationId): void {
      const snapshot: StoredSnapshot = {
        version: 1,
        sessionId,
        incarnationId,
        data: '',
        capturedAt: now(),
        truncated: false,
        incomplete: false
      }
      snapshotsBySessionId.set(sessionId, snapshot)
      if (!persist(snapshot)) snapshotsBySessionId.set(sessionId, { ...snapshot, incomplete: true })
    },
    append(sessionId, incarnationId, data): void {
      const existing = read(sessionId)
      if (!existing || existing.incarnationId !== incarnationId) return
      const combined = `${existing.data}${data}`
      const bounded = boundedSuffix(combined, maxBytes)
      const wasTruncated = Buffer.byteLength(combined, 'utf8') > maxBytes
      const snapshot: StoredSnapshot = {
        ...existing,
        data: bounded,
        capturedAt: now(),
        truncated: existing.truncated || wasTruncated,
        incomplete: existing.incomplete || wasTruncated
      }
      snapshotsBySessionId.set(sessionId, snapshot)
      if (!persist(snapshot)) snapshotsBySessionId.set(sessionId, { ...snapshot, incomplete: true })
    },
    load(sessionId): TerminalScrollbackSnapshot | null {
      const snapshot = read(sessionId)
      if (!snapshot) return null
      if (now() - snapshot.capturedAt > maxAgeMs) {
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

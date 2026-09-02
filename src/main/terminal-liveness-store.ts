import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { TerminalLiveness, WorkspaceState, WorkspaceTerminalNode } from '../shared/terminal'

export const TERMINAL_LIVENESS_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

export interface TerminalLivenessRecord {
  incarnationId: string
  liveness: TerminalLiveness
  at: number
}

interface StoredJournal {
  version: 1
  sessions: Record<string, TerminalLivenessRecord>
}

export interface TerminalLivenessStoreOptions {
  path: string
  maxAgeMs?: number
  now?: () => number
}

/**
 * The durable home for the process owner's liveness verdict. `terminal-manager` holds the live
 * verdict in memory, which dies with the main process, so a terminal killed during shutdown could
 * never say so afterwards and every restored terminal hydrated as `unverifiable`. Writing each
 * transition here as it happens keeps the quit path free of any deadline: by the time
 * `before-quit` kills a terminal, the record it needs is already on disk.
 *
 * This is deliberately not the scrollback store. Retained output is display-only and must never
 * become evidence about a process; this file is evidence and holds no output.
 */
export interface TerminalLivenessStore {
  /** Records the owner's verdict for one exact incarnation, replacing any earlier one. */
  record(sessionId: string, incarnationId: string, liveness: TerminalLiveness): void
  read(sessionId: string): TerminalLivenessRecord | null
  remove(sessionId: string): void
}

function isRecord(value: unknown): value is TerminalLivenessRecord {
  if (!value || typeof value !== 'object') return false
  const record = value as Partial<TerminalLivenessRecord>
  return (
    typeof record.incarnationId === 'string' &&
    typeof record.at === 'number' &&
    Number.isFinite(record.at) &&
    (record.liveness === 'live' || record.liveness === 'unverifiable' || record.liveness === 'exited')
  )
}

function readJournal(path: string): Map<string, TerminalLivenessRecord> {
  const sessions = new Map<string, TerminalLivenessRecord>()
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (!parsed || typeof parsed !== 'object' || (parsed as StoredJournal).version !== 1) return sessions
    const stored = (parsed as StoredJournal).sessions
    if (!stored || typeof stored !== 'object') return sessions
    for (const [sessionId, record] of Object.entries(stored)) {
      if (isRecord(record)) sessions.set(sessionId, record)
    }
  } catch {
    // A missing or unreadable journal means no verdict, never a failed launch. The next
    // recorded transition rewrites the file from scratch.
  }
  return sessions
}

export function createTerminalLivenessStore(options: TerminalLivenessStoreOptions): TerminalLivenessStore {
  const maxAgeMs = Math.max(0, options.maxAgeMs ?? TERMINAL_LIVENESS_MAX_AGE_MS)
  const now = options.now ?? Date.now
  const sessions = readJournal(options.path)

  const persist = (): void => {
    const journal: StoredJournal = { version: 1, sessions: Object.fromEntries(sessions) }
    const temporary = `${options.path}.tmp`
    try {
      mkdirSync(dirname(options.path), { recursive: true })
      // Synchronous by design: `before-quit` cannot await a promise, so the verdict has to be
      // on disk before this call returns or shutdown would race it away.
      writeFileSync(temporary, JSON.stringify(journal), 'utf8')
      renameSync(temporary, options.path)
    } catch {
      if (existsSync(temporary)) {
        try {
          unlinkSync(temporary)
        } catch {
          /* Best-effort cleanup; the in-memory verdict below is still correct. */
        }
      }
    }
  }

  return {
    record(sessionId, incarnationId, liveness): void {
      sessions.set(sessionId, { incarnationId, liveness, at: now() })
      persist()
    },
    read(sessionId): TerminalLivenessRecord | null {
      const record = sessions.get(sessionId)
      if (!record) return null
      if (now() - record.at > maxAgeMs) {
        sessions.delete(sessionId)
        persist()
        return null
      }
      return record
    },
    remove(sessionId): void {
      if (!sessions.delete(sessionId)) return
      persist()
    }
  }
}

/**
 * The durable session identity behind a canvas node. `terminal-manager` derives it the same way,
 * so nodes saved before sessions had their own identity still resolve to their process record.
 */
function sessionIdOf(node: WorkspaceTerminalNode): string {
  return node.sessionId ?? node.id
}

/**
 * Stamps each restored plain terminal with the last verdict its process owner recorded. Only a
 * durable `exited` restores as exited; anything else stays `unverifiable`, because a record still
 * reading `live` means the previous run ended without ever killing that terminal.
 */
export function applyRestoredTerminalLiveness(
  state: WorkspaceState,
  read: (sessionId: string) => TerminalLivenessRecord | null
): WorkspaceState {
  return {
    ...state,
    nodes: state.nodes.map((node) => {
      if (node.kind !== 'terminal') return node
      const record = read(sessionIdOf(node))
      return { ...node, terminalLiveness: record?.liveness === 'exited' ? 'exited' : 'unverifiable' }
    })
  }
}

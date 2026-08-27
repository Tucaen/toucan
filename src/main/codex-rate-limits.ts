import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentRateLimitStatus, AgentRateLimitWindow } from '../shared/agent'

/**
 * Codex has no API for account usage limits, but its own rollout transcripts carry them: every
 * `token_count` event embeds the `rate_limits` payload the CLI received from the server. Reading the
 * newest transcript therefore reports account-wide usage without starting a session or spending
 * tokens - and keeps working when no Codex node is open at all.
 *
 * Windows are tagged only by length, so they are bucketed by `window_minutes` rather than by name:
 * anything up to six hours is the short rolling window, anything longer is the weekly one.
 */
const SHORT_WINDOW_MAX_MINUTES = 360

/** How many day-partitioned directories back to look before giving up on finding a transcript. */
const SEARCH_DAYS = 14

const TAIL_BYTES = 256 * 1024

interface CodexWindowPayload {
  used_percent?: unknown
  window_minutes?: unknown
  resets_at?: unknown
}

interface CodexRateLimitsPayload {
  primary?: CodexWindowPayload | null
  secondary?: CodexWindowPayload | null
  rate_limit_reached_type?: unknown
}

function sessionDirectories(root: string, now: Date): string[] {
  const directories: string[] = []
  for (let daysAgo = 0; daysAgo < SEARCH_DAYS; daysAgo += 1) {
    const date = new Date(now)
    date.setDate(date.getDate() - daysAgo)
    directories.push(join(
      root,
      String(date.getFullYear()),
      String(date.getMonth() + 1).padStart(2, '0'),
      String(date.getDate()).padStart(2, '0')
    ))
  }
  return directories
}

/** The most recently modified `.jsonl` transcript, searching newest day partitions first. */
function newestTranscript(root: string, now: Date): string | null {
  for (const directory of sessionDirectories(root, now)) {
    if (!existsSync(directory)) continue
    let newest: { path: string; modifiedAt: number } | null = null
    try {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
        const path = join(directory, entry.name)
        try {
          const modifiedAt = statSync(path).mtimeMs
          if (!newest || modifiedAt > newest.modifiedAt) newest = { path, modifiedAt }
        } catch {
          // A transcript can be rotated away mid-scan; the next candidate still counts.
        }
      }
    } catch {
      // An unreadable day partition should not stop the search from reaching older ones.
    }
    if (newest) return newest.path
  }
  return null
}

function readTail(path: string): string[] {
  const size = statSync(path).size
  const start = Math.max(0, size - TAIL_BYTES)
  const length = size - start
  if (length <= 0) return []
  const buffer = Buffer.alloc(length)
  const handle = openSync(path, 'r')
  try {
    readSync(handle, buffer, 0, length, start)
  } finally {
    closeSync(handle)
  }
  const lines = buffer.toString('utf8').split(/\r?\n/)
  // A mid-record start offset leaves a partial first line that can never parse.
  if (start > 0) lines.shift()
  return lines.filter(Boolean)
}

function toWindow(payload: CodexWindowPayload | null | undefined): { window: AgentRateLimitWindow; minutes: number } | null {
  if (!payload || typeof payload.used_percent !== 'number' || typeof payload.window_minutes !== 'number') return null
  // `resets_at` is epoch seconds, unlike every other timestamp ADE handles.
  const resetsAt = typeof payload.resets_at === 'number' ? payload.resets_at * 1000 : undefined
  return {
    window: { usedPercent: payload.used_percent, ...(resetsAt !== undefined ? { resetsAt } : {}) },
    minutes: payload.window_minutes
  }
}

/** Exported for tests: turns one transcript's lines into the newest usable rate-limit report. */
export function parseCodexRateLimits(lines: string[]): AgentRateLimitStatus | null {
  // Later records supersede earlier ones, so scan backwards and stop at the first usable report.
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    let payload: CodexRateLimitsPayload | undefined
    try {
      const record = JSON.parse(lines[index]) as {
        type?: unknown
        payload?: { type?: unknown; rate_limits?: CodexRateLimitsPayload | null }
      }
      if (record.type !== 'event_msg' || record.payload?.type !== 'token_count') continue
      payload = record.payload.rate_limits ?? undefined
    } catch {
      continue
    }
    if (!payload) continue
    const status: AgentRateLimitStatus = {}
    for (const candidate of [toWindow(payload.primary), toWindow(payload.secondary)]) {
      if (!candidate) continue
      const slot = candidate.minutes <= SHORT_WINDOW_MAX_MINUTES ? 'fiveHour' : 'weekly'
      status[slot] = candidate.window
    }
    if (typeof payload.rate_limit_reached_type === 'string') status.rejected = true
    if (status.fiveHour || status.weekly) return status
  }
  return null
}

export interface CodexRateLimitReaderOptions {
  homeDirectory: string
  environment: NodeJS.ProcessEnv
  /** Injected in tests so a fixture's day partition is the one searched. */
  now?(): Date
}

export interface CodexRateLimitReader {
  read(): AgentRateLimitStatus | null
}

export function createCodexRateLimitReader(options: CodexRateLimitReaderOptions): CodexRateLimitReader {
  const now = options.now ?? ((): Date => new Date())
  return {
    read(): AgentRateLimitStatus | null {
      const root = join(options.environment.CODEX_HOME ?? join(options.homeDirectory, '.codex'), 'sessions')
      try {
        const transcript = newestTranscript(root, now())
        return transcript ? parseCodexRateLimits(readTail(transcript)) : null
      } catch {
        return null
      }
    }
  }
}

import { spawn } from 'node:child_process'
import { hiddenProcessOptions } from './background-process'
import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from 'node:fs'
import { extname, join, win32 } from 'node:path'
import { createInterface } from 'node:readline'
import type { AgentModelRateLimitWindow, AgentRateLimitStatus, AgentRateLimitWindow } from '../shared/agent'
import { withStallGuard } from '../shared/stall-guard'

/**
 * Codex app-server exposes account limits without starting a turn or spending tokens. Rollout
 * transcripts carry the same payload and remain a useful fallback when the installed CLI predates
 * that endpoint or cannot be started.
 *
 * Windows are tagged only by length, so they are bucketed by `window_minutes` rather than by name:
 * anything up to six hours is the short rolling window, anything longer is the weekly one.
 */
const SHORT_WINDOW_MAX_MINUTES = 360

/** How many day-partitioned directories back to look before giving up on finding a transcript. */
const SEARCH_DAYS = 14

const TAIL_BYTES = 256 * 1024

/** A local app-server round trip should be quick; this prevents a wedged CLI from stalling IPC. */
const READ_TIMEOUT_MS = 10_000

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

interface CodexAppServerWindow {
  usedPercent?: unknown
  windowDurationMins?: unknown
  resetsAt?: unknown
}

interface CodexAppServerSnapshot {
  limitId?: unknown
  limitName?: unknown
  primary?: CodexAppServerWindow | null
  secondary?: CodexAppServerWindow | null
  rateLimitReachedType?: unknown
}

interface CodexAppServerResponse {
  rateLimits?: CodexAppServerSnapshot | null
  rateLimitsByLimitId?: Record<string, CodexAppServerSnapshot> | null
}

function sessionDirectories(root: string, now: Date): string[] {
  const directories: string[] = []
  for (let daysAgo = 0; daysAgo < SEARCH_DAYS; daysAgo += 1) {
    const date = new Date(now)
    date.setDate(date.getDate() - daysAgo)
    directories.push(
      join(
        root,
        String(date.getFullYear()),
        String(date.getMonth() + 1).padStart(2, '0'),
        String(date.getDate()).padStart(2, '0')
      )
    )
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

function toWindow(
  payload: CodexWindowPayload | null | undefined
): { window: AgentRateLimitWindow; minutes: number } | null {
  if (!payload || typeof payload.used_percent !== 'number' || typeof payload.window_minutes !== 'number') return null
  // `resets_at` is epoch seconds, unlike every other timestamp Toucan handles.
  const resetsAt = typeof payload.resets_at === 'number' ? payload.resets_at * 1000 : undefined
  return {
    window: { usedPercent: payload.used_percent, ...(resetsAt !== undefined ? { resetsAt } : {}) },
    minutes: payload.window_minutes
  }
}

function toAppServerWindow(
  payload: CodexAppServerWindow | null | undefined
): { window: AgentRateLimitWindow; minutes: number } | null {
  if (!payload || typeof payload.usedPercent !== 'number' || typeof payload.windowDurationMins !== 'number') return null
  // App-server uses epoch seconds too, despite exposing camelCase field names.
  const resetsAt = typeof payload.resetsAt === 'number' ? payload.resetsAt * 1000 : undefined
  return {
    window: { usedPercent: payload.usedPercent, ...(resetsAt !== undefined ? { resetsAt } : {}) },
    minutes: payload.windowDurationMins
  }
}

function statusFromWindows(
  primary: { window: AgentRateLimitWindow; minutes: number } | null,
  secondary: { window: AgentRateLimitWindow; minutes: number } | null,
  rejected: boolean
): AgentRateLimitStatus | null {
  const status: AgentRateLimitStatus = {}
  for (const candidate of [primary, secondary]) {
    if (!candidate) continue
    const slot = candidate.minutes <= SHORT_WINDOW_MAX_MINUTES ? 'fiveHour' : 'weekly'
    status[slot] = candidate.window
  }
  if (rejected) status.rejected = true
  return status.fiveHour || status.weekly ? status : null
}

/** The account-wide Codex allowance; every other id in `rateLimitsByLimitId` meters something narrower. */
const CODEX_LIMIT_ID = 'codex'

/**
 * App-server keys every allowance by `limitId`, and the response shape leaves room for more than
 * the account-wide one. Anything beyond `codex` is shown as a named allowance alongside Claude's
 * per-model windows. Its longest window is the one surfaced, matching the weekly scope Claude uses
 * per model; a limit that only reports a short window contributes that instead of vanishing.
 */
function modelWindowsFromAppServer(
  byLimitId: Record<string, CodexAppServerSnapshot> | null | undefined
): AgentModelRateLimitWindow[] {
  if (!byLimitId || typeof byLimitId !== 'object') return []
  const models: AgentModelRateLimitWindow[] = []
  for (const [limitId, snapshot] of Object.entries(byLimitId)) {
    if (limitId === CODEX_LIMIT_ID || !snapshot || typeof snapshot !== 'object') continue
    const windows = [toAppServerWindow(snapshot.primary), toAppServerWindow(snapshot.secondary)].filter(
      (candidate): candidate is NonNullable<typeof candidate> => candidate !== null
    )
    if (windows.length === 0) continue
    const longest = windows.reduce((a, b) => (b.minutes > a.minutes ? b : a))
    const label =
      typeof snapshot.limitName === 'string' && snapshot.limitName.trim() !== '' ? snapshot.limitName.trim() : limitId
    models.push({ label, ...longest.window })
  }
  return models
}

/** Exported for tests: maps the live app-server response onto the renderer's provider shape. */
export function codexRateLimitsFromAppServer(response: unknown): AgentRateLimitStatus | null {
  if (!response || typeof response !== 'object') return null
  const payload = response as CodexAppServerResponse
  const snapshot = payload.rateLimitsByLimitId?.[CODEX_LIMIT_ID] ?? payload.rateLimits
  if (!snapshot || (snapshot.limitId !== undefined && snapshot.limitId !== null && snapshot.limitId !== CODEX_LIMIT_ID))
    return null
  const status = statusFromWindows(
    toAppServerWindow(snapshot.primary),
    toAppServerWindow(snapshot.secondary),
    typeof snapshot.rateLimitReachedType === 'string'
  )
  if (!status) return null
  const models = modelWindowsFromAppServer(payload.rateLimitsByLimitId)
  return models.length > 0 ? { ...status, models } : status
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
    const status = statusFromWindows(
      toWindow(payload.primary),
      toWindow(payload.secondary),
      typeof payload.rate_limit_reached_type === 'string'
    )
    if (status) return status
  }
  return null
}

export interface CodexRateLimitReaderOptions {
  homeDirectory: string
  environment: NodeJS.ProcessEnv
  /** Injected in tests so a fixture's day partition is the one searched. */
  now?(): Date
  /** Injected in tests so no Codex process is spawned. */
  requestRateLimits?(): Promise<unknown>
  /** Resolved Codex CLI command; absent means transcript-only fallback. */
  command?: string | null
}

export interface CodexRateLimitReader {
  read(): Promise<AgentRateLimitStatus | null>
}

interface CodexAppServerLaunch {
  executable: string
  args: string[]
}

/**
 * npm exposes Windows CLIs as `.cmd` shims, which `child_process.spawn` cannot execute directly.
 * Resolve Codex's platform package and launch its native executable directly. Going through
 * `codex.js` leaves that wrapper to spawn the native binary with inherited stdio, which can briefly
 * surface a `PseudoConsoleWindow` even when the wrapper itself was started with `windowsHide`.
 */
export function resolveCodexAppServerLaunch(
  command: string,
  architecture: NodeJS.Architecture = process.arch,
  pathExists: (path: string) => boolean = existsSync
): CodexAppServerLaunch | null {
  if (!['.cmd', '.bat'].includes(extname(command).toLowerCase())) {
    return { executable: command, args: ['app-server', '--listen', 'stdio://'] }
  }

  const target =
    architecture === 'x64'
      ? { packageName: 'codex-win32-x64', triple: 'x86_64-pc-windows-msvc' }
      : architecture === 'arm64'
        ? { packageName: 'codex-win32-arm64', triple: 'aarch64-pc-windows-msvc' }
        : null
  if (!target) return null

  const commandDirectory = win32.dirname(command)
  const packageRoots = [win32.join(commandDirectory, 'node_modules'), win32.join(commandDirectory, '..')]
  const nativeRelativePath = ['@openai', target.packageName, 'vendor', target.triple, 'bin', 'codex.exe']
  const executable = packageRoots
    .flatMap((root) => [
      win32.join(root, ...nativeRelativePath),
      win32.join(root, '@openai', 'codex', 'node_modules', ...nativeRelativePath)
    ])
    .find(pathExists)
  return executable ? { executable, args: ['app-server', '--listen', 'stdio://'] } : null
}

async function requestRateLimitsViaAppServer(command: string, environment: NodeJS.ProcessEnv): Promise<unknown> {
  const launch = resolveCodexAppServerLaunch(command)
  if (!launch) throw new Error('Codex command shim could not be resolved')
  const child = spawn(
    launch.executable,
    launch.args,
    hiddenProcessOptions({
      env: { ...environment },
      stdio: ['pipe', 'pipe', 'ignore']
    })
  )

  const response = new Promise<unknown>((resolve, reject) => {
    const lines = createInterface({ input: child.stdout })
    child.once('error', reject)
    child.stdin.once('error', reject)
    child.once('exit', (code) => reject(new Error(`Codex app-server exited before replying (${code ?? 'unknown'})`)))
    lines.on('line', (line) => {
      let message: { id?: unknown; result?: unknown; error?: unknown }
      try {
        message = JSON.parse(line) as typeof message
      } catch {
        return
      }
      if (message.id === 1) {
        child.stdin.write(`${JSON.stringify({ id: 2, method: 'account/rateLimits/read' })}\n`)
      } else if (message.id === 2) {
        if (message.error !== undefined) reject(new Error('Codex app-server rejected the rate-limit request'))
        else resolve(message.result)
      }
    })

    child.stdin.write(
      `${JSON.stringify({
        id: 1,
        method: 'initialize',
        params: { clientInfo: { name: 'toucan', version: '0.1.0' } }
      })}\n`
    )
  })

  try {
    return await withStallGuard(response, READ_TIMEOUT_MS, 'Codex rate-limit request timed out')
  } finally {
    child.kill()
  }
}

export function createCodexRateLimitReader(options: CodexRateLimitReaderOptions): CodexRateLimitReader {
  const now = options.now ?? ((): Date => new Date())
  const requestRateLimits =
    options.requestRateLimits ??
    (options.command
      ? (): Promise<unknown> => requestRateLimitsViaAppServer(options.command!, options.environment)
      : null)
  return {
    async read(): Promise<AgentRateLimitStatus | null> {
      if (requestRateLimits) {
        try {
          const live = codexRateLimitsFromAppServer(await requestRateLimits())
          if (live) return live
        } catch {
          // Older, missing, unauthenticated, or stalled CLIs fall through to the transcript cache.
        }
      }
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

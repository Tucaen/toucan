import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs'
import { extname, join, normalize } from 'node:path'
import type { ConversationPreview, TerminalCreateRequest, TerminalKind } from '../shared/terminal'

export interface SessionLaunch {
  executable: string
  args: string[]
}

export interface SessionLaunchError {
  error: string
}

export interface SessionProviderOptions {
  homeDirectory: string
  environment: NodeJS.ProcessEnv
  resolveCommand(command: string): string | null
}

export interface SessionProviders {
  resolveLaunch(request: TerminalCreateRequest): SessionLaunch | SessionLaunchError
  discoverConversation(kind: TerminalKind, cwd: string, startedAt: number, claimed: ReadonlySet<string>): string | null
  getConversationPreview(kind: 'claude' | 'codex', conversationId: string): ConversationPreview | null
}

function codexSessionDirectories(root: string, now: Date): string[] {
  return [0, 1].map((daysAgo) => {
    const date = new Date(now)
    date.setDate(date.getDate() - daysAgo)
    return join(
      root,
      String(date.getFullYear()),
      String(date.getMonth() + 1).padStart(2, '0'),
      String(date.getDate()).padStart(2, '0')
    )
  })
}

function findFile(root: string, matches: (filename: string) => boolean): string | null {
  if (!existsSync(root)) return null
  const pending = [root]
  while (pending.length > 0) {
    const directory = pending.pop()!
    try {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name)
        if (entry.isDirectory()) pending.push(path)
        else if (entry.isFile() && matches(entry.name)) return path
      }
    } catch {
      // Provider cleanup can race transcript discovery; the next request retries.
    }
  }
  return null
}

function readJsonlTail(path: string, maximumBytes = 4 * 1024 * 1024): string[] {
  const size = statSync(path).size
  const start = Math.max(0, size - maximumBytes)
  const length = size - start
  const buffer = Buffer.alloc(length)
  const handle = openSync(path, 'r')
  try {
    readSync(handle, buffer, 0, length, start)
  } finally {
    closeSync(handle)
  }
  const lines = buffer.toString('utf8').split(/\r?\n/)
  if (start > 0) lines.shift()
  return lines.filter(Boolean)
}

function excerpt(value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  return normalized.length > 280 ? `${normalized.slice(0, 277)}…` : normalized
}

function claudeText(content: unknown): string | null {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return null
  const text = content
    .filter((item): item is { type: string; text: string } => (
      Boolean(item)
      && typeof item === 'object'
      && (item as { type?: unknown }).type === 'text'
      && typeof (item as { text?: unknown }).text === 'string'
    ))
    .map((item) => item.text)
    .join('\n')
  return text || null
}

function parseClaudePreview(lines: string[]): ConversationPreview | null {
  let user: string | undefined
  let assistant: string | undefined
  let updatedAt = ''
  for (const line of lines) {
    try {
      const record = JSON.parse(line) as {
        timestamp?: string
        isMeta?: boolean
        isSidechain?: boolean
        message?: { role?: string; content?: unknown }
      }
      if (record.isMeta || record.isSidechain || !['user', 'assistant'].includes(record.message?.role ?? '')) continue
      const text = claudeText(record.message?.content)
      if (!text) continue
      if (record.message?.role === 'user') user = excerpt(text)
      if (record.message?.role === 'assistant') assistant = excerpt(text)
      if (record.timestamp) updatedAt = record.timestamp
    } catch {
      // Ignore partial and provider-specific transcript records.
    }
  }
  return user || assistant ? { user, assistant, updatedAt: updatedAt || new Date().toISOString() } : null
}

function parseCodexPreview(lines: string[]): ConversationPreview | null {
  let user: string | undefined
  let assistant: string | undefined
  let updatedAt = ''
  for (const line of lines) {
    try {
      const record = JSON.parse(line) as {
        type?: string
        timestamp?: string
        payload?: { type?: string; role?: string; content?: Array<{ type?: string; text?: string }> }
      }
      if (record.type !== 'response_item' || record.payload?.type !== 'message') continue
      const contentType = record.payload.role === 'user' ? 'input_text' : 'output_text'
      const text = record.payload.content
        ?.filter((item) => item.type === contentType && item.text)
        .map((item) => item.text!)
        .join('\n')
      if (!text) continue
      if (record.payload.role === 'user') user = excerpt(text)
      if (record.payload.role === 'assistant') assistant = excerpt(text)
      if (record.timestamp) updatedAt = record.timestamp
    } catch {
      // Ignore partial and provider-specific transcript records.
    }
  }
  return user || assistant ? { user, assistant, updatedAt: updatedAt || new Date().toISOString() } : null
}

export function createSessionProviders(options: SessionProviderOptions): SessionProviders {
  const conversationFiles = new Map<string, string>()
  return {
    resolveLaunch(request): SessionLaunch | SessionLaunchError {
      if (request.kind === 'terminal') {
        const pwsh = options.resolveCommand('pwsh.exe')
        if (pwsh) return { executable: pwsh, args: ['-NoLogo'] }
        const powershell = options.resolveCommand('powershell.exe')
        if (powershell) return { executable: powershell, args: ['-NoLogo'] }
        return { executable: options.environment.ComSpec ?? 'cmd.exe', args: [] }
      }
      const command = request.kind
      const resolved = options.resolveCommand(command)
      if (!resolved) {
        return { error: `${command} is not installed or is not available on PATH. Install it, restart ADE, and try again.` }
      }

      if (request.resume && !request.conversationId) {
        return { error: `ADE does not have a saved ${command} conversation ID for this node.` }
      }
      const args = request.kind === 'claude'
        ? request.resume
          ? ['--resume', request.conversationId!]
          : request.conversationId
            ? ['--session-id', request.conversationId]
            : []
        : request.resume
          ? ['resume', request.conversationId!]
          : []
      if (extname(resolved).toLowerCase() === '.cmd' || extname(resolved).toLowerCase() === '.bat') {
        return {
          executable: options.environment.ComSpec ?? 'cmd.exe',
          args: ['/d', '/s', '/c', resolved, ...args]
        }
      }
      return { executable: resolved, args }
    },
    discoverConversation(kind, cwd, startedAt, claimed): string | null {
      if (kind !== 'codex') return null
      const root = join(options.environment.CODEX_HOME ?? join(options.homeDirectory, '.codex'), 'sessions')
      const candidates: Array<{ id: string; path: string; startedAt: number }> = []
      for (const directory of codexSessionDirectories(root, new Date(startedAt))) {
        if (!existsSync(directory)) continue
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
          if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
          try {
            const filePath = join(directory, entry.name)
            if (statSync(filePath).birthtimeMs < startedAt - 3000) continue
            const firstLine = readFileSync(filePath, 'utf8').split(/\r?\n/, 1)[0]
            const record = JSON.parse(firstLine) as {
              type?: string
              payload?: { id?: string; cwd?: string; timestamp?: string }
            }
            const id = record.payload?.id
            const sessionCwd = record.payload?.cwd
            const sessionStartedAt = Date.parse(record.payload?.timestamp ?? '')
            if (
              record.type === 'session_meta'
              && id
              && sessionCwd
              && !claimed.has(id)
              && normalize(sessionCwd).toLocaleLowerCase() === normalize(cwd).toLocaleLowerCase()
              && Number.isFinite(sessionStartedAt)
              && sessionStartedAt >= startedAt - 3000
            ) {
              candidates.push({ id, path: filePath, startedAt: sessionStartedAt })
            }
          } catch {
            // The CLI may still be writing its first record; the next poll retries.
          }
        }
      }
      candidates.sort((left, right) => Math.abs(left.startedAt - startedAt) - Math.abs(right.startedAt - startedAt))
      const match = candidates[0]
      if (!match) return null
      conversationFiles.set(`codex:${match.id}`, match.path)
      return match.id
    },
    getConversationPreview(kind, conversationId): ConversationPreview | null {
      const key = `${kind}:${conversationId}`
      const cached = conversationFiles.get(key)
      const root = kind === 'claude'
        ? join(options.environment.CLAUDE_CONFIG_DIR ?? join(options.homeDirectory, '.claude'), 'projects')
        : join(options.environment.CODEX_HOME ?? join(options.homeDirectory, '.codex'), 'sessions')
      const path = cached && existsSync(cached)
        ? cached
        : findFile(root, (filename) => kind === 'claude'
          ? filename === `${conversationId}.jsonl`
          : filename.endsWith(`${conversationId}.jsonl`))
      if (!path) return null
      conversationFiles.set(key, path)
      try {
        const lines = readJsonlTail(path)
        return kind === 'claude' ? parseClaudePreview(lines) : parseCodexPreview(lines)
      } catch {
        return null
      }
    }
  }
}

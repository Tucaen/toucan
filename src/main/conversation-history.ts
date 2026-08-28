import { open, readdir, readFile, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type {
  ConversationListPage,
  ConversationListRequest,
  ConversationProvider,
  ConversationSummary
} from '../shared/conversation'

export interface ConversationHistoryOptions {
  homeDirectory: string
  environment: NodeJS.ProcessEnv
}

export interface ConversationHistory {
  /**
   * Lists past conversations for the given directories, newest first. Only the requested page is
   * parsed; every other candidate costs a directory entry and, for Codex, one cached head read.
   */
  list(request: ConversationListRequest): Promise<ConversationListPage>
  /** Whether a listed transcript is still on disk, so an open can refuse honestly. */
  exists(path: string): Promise<boolean>
}

interface Candidate {
  provider: ConversationProvider
  id: string
  path: string
  cwd: string
  sortAt: number
}

interface Detail {
  title: string
  updatedAt: string
  messageCount: number
}

/** Caps concurrent transcript reads so a large history cannot stall the main process. */
const READ_CONCURRENCY = 24
const DEFAULT_LIMIT = 25
const CACHE_LIMIT = 1000

/** Claude names a project directory after its cwd with every non-alphanumeric byte replaced. */
export function encodeClaudeProjectDirectory(directory: string): string {
  return directory.replace(/[^a-zA-Z0-9]/g, '-')
}

function trim<K, V>(cache: Map<K, V>): void {
  while (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next()
    if (oldest.done) return
    cache.delete(oldest.value)
  }
}

async function mapLimited<T, R>(items: T[], worker: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const runners = Array.from({ length: Math.min(READ_CONCURRENCY, items.length) }, async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await worker(items[index])
    }
  })
  await Promise.all(runners)
  return results
}

async function readHead(path: string, bytes: number): Promise<string> {
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(bytes)
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0)
    return buffer.toString('utf8', 0, bytesRead)
  } finally {
    await handle.close()
  }
}

function excerpt(value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  return normalized.length > 120 ? `${normalized.slice(0, 117)}…` : normalized
}

/**
 * Both providers inject context blocks (`<environment_context>`, plugin catalogues) as user
 * turns. They are never what the user typed, so they must not become a conversation's title.
 */
function isInjectedUserText(text: string): boolean {
  return text.trimStart().startsWith('<')
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

function parseClaudeDetail(content: string, fallbackUpdatedAt: string): Detail {
  let title = ''
  let firstUserText = ''
  let updatedAt = ''
  let messageCount = 0
  for (const line of content.split(/\r?\n/)) {
    if (!line) continue
    let record: {
      type?: string
      aiTitle?: string
      timestamp?: string
      isMeta?: boolean
      isSidechain?: boolean
      message?: { role?: string; content?: unknown }
    }
    try {
      record = JSON.parse(line)
    } catch {
      continue
    }
    if (record.type === 'ai-title' && typeof record.aiTitle === 'string' && record.aiTitle.trim()) {
      title = record.aiTitle.trim()
      continue
    }
    const role = record.message?.role
    if (record.isMeta || record.isSidechain || (role !== 'user' && role !== 'assistant')) continue
    messageCount += 1
    if (record.timestamp) updatedAt = record.timestamp
    if (!firstUserText && role === 'user') {
      const text = claudeText(record.message?.content)
      if (text && !isInjectedUserText(text)) firstUserText = excerpt(text)
    }
  }
  return {
    title: title || firstUserText || 'Untitled conversation',
    updatedAt: updatedAt || fallbackUpdatedAt,
    messageCount
  }
}

function parseCodexDetail(content: string, fallbackUpdatedAt: string): Detail {
  let firstUserText = ''
  let updatedAt = ''
  let messageCount = 0
  for (const line of content.split(/\r?\n/)) {
    if (!line) continue
    let record: {
      type?: string
      timestamp?: string
      payload?: { type?: string; role?: string; content?: Array<{ type?: string; text?: string }> }
    }
    try {
      record = JSON.parse(line)
    } catch {
      continue
    }
    if (record.type !== 'response_item' || record.payload?.type !== 'message') continue
    const role = record.payload.role
    if (role !== 'user' && role !== 'assistant') continue
    messageCount += 1
    if (record.timestamp) updatedAt = record.timestamp
    if (!firstUserText && role === 'user') {
      const text = record.payload.content
        ?.filter((item) => (item.type === 'input_text' || item.type === 'text') && item.text)
        .map((item) => item.text!)
        .join('\n')
      if (text && !isInjectedUserText(text)) firstUserText = excerpt(text)
    }
  }
  return {
    title: firstUserText || 'Untitled conversation',
    updatedAt: updatedAt || fallbackUpdatedAt,
    messageCount
  }
}

interface CodexMeta {
  id: string
  cwd: string
  startedAt: number
  /** Codex records subagent rollouts beside real ones; only user threads are resumable here. */
  subagent: boolean
}

export function extractCodexMeta(head: string): CodexMeta | null {
  const firstLine = head.split(/\r?\n/, 1)[0]
  try {
    const record = JSON.parse(firstLine) as {
      type?: string
      payload?: { id?: string; cwd?: string; timestamp?: string; thread_source?: string }
    }
    if (record.type !== 'session_meta' || !record.payload?.id || !record.payload.cwd) return null
    return {
      id: record.payload.id,
      cwd: record.payload.cwd,
      startedAt: Date.parse(record.payload.timestamp ?? '') || 0,
      subagent: record.payload.thread_source === 'subagent'
    }
  } catch {
    // A session_meta line carrying full base instructions can outrun the head read, so the few
    // fields this listing needs - all written before them - are recovered from the head directly.
    if (!head.startsWith('{"timestamp"') && !head.includes('"type":"session_meta"')) return null
    const id = /"id":"([^"]+)"/.exec(head)?.[1]
    const rawCwd = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(head)?.[1]
    if (!id || rawCwd === undefined) return null
    try {
      return {
        id,
        cwd: JSON.parse(`"${rawCwd}"`) as string,
        startedAt: Date.parse(/"timestamp":"([^"]+)"/.exec(head)?.[1] ?? '') || 0,
        subagent: /"thread_source":"subagent"/.test(head)
      }
    } catch {
      return null
    }
  }
}

async function listJsonlFiles(directory: string): Promise<string[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true })
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
      .map((entry) => join(directory, entry.name))
  } catch {
    return []
  }
}

async function listSubdirectories(directory: string): Promise<string[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true })
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  } catch {
    return []
  }
}

export function createConversationHistory(options: ConversationHistoryOptions): ConversationHistory {
  const codexMeta = new Map<string, CodexMeta | null>()
  const details = new Map<string, { mtimeMs: number; size: number; detail: Detail }>()

  const claudeRoot = (): string => join(
    options.environment.CLAUDE_CONFIG_DIR ?? join(options.homeDirectory, '.claude'),
    'projects'
  )
  const codexRoot = (): string => join(
    options.environment.CODEX_HOME ?? join(options.homeDirectory, '.codex'),
    'sessions'
  )

  async function claudeCandidates(directories: string[]): Promise<Candidate[]> {
    const root = claudeRoot()
    const byLowerName = new Map(
      (await listSubdirectories(root)).map((name) => [name.toLocaleLowerCase(), name])
    )
    const candidates: Candidate[] = []
    for (const directory of directories) {
      // The same checkout reaches Claude with either drive-letter case, so the encoded
      // directory name is matched case-insensitively rather than assumed.
      const actual = byLowerName.get(encodeClaudeProjectDirectory(directory).toLocaleLowerCase())
      if (!actual) continue
      const stats = await mapLimited(await listJsonlFiles(join(root, actual)), async (path) => {
        try {
          return { path, mtimeMs: (await stat(path)).mtimeMs }
        } catch {
          return null
        }
      })
      for (const entry of stats) {
        if (!entry) continue
        candidates.push({
          provider: 'claude',
          id: basename(entry.path, '.jsonl'),
          path: entry.path,
          cwd: directory,
          sortAt: entry.mtimeMs
        })
      }
    }
    return candidates
  }

  async function codexCandidates(directories: string[]): Promise<Candidate[]> {
    const root = codexRoot()
    const wanted = new Map(directories.map((directory) => [directory.toLocaleLowerCase(), directory]))
    const files: string[] = []
    for (const year of await listSubdirectories(root)) {
      const yearPath = join(root, year)
      for (const month of await listSubdirectories(yearPath)) {
        const monthPath = join(yearPath, month)
        for (const day of await listSubdirectories(monthPath)) {
          files.push(...await listJsonlFiles(join(monthPath, day)))
        }
      }
    }
    const metas = await mapLimited(files, async (path) => {
      const cached = codexMeta.get(path)
      if (cached !== undefined) return { path, meta: cached }
      let meta: CodexMeta | null = null
      try {
        meta = extractCodexMeta(await readHead(path, 16 * 1024))
      } catch {
        meta = null
      }
      // A session_meta line never changes once written, so this is cached by path alone.
      codexMeta.set(path, meta)
      trim(codexMeta)
      return { path, meta }
    })
    const candidates: Candidate[] = []
    for (const entry of metas) {
      const meta = entry.meta
      if (!meta || meta.subagent) continue
      const directory = wanted.get(meta.cwd.toLocaleLowerCase())
      if (!directory) continue
      let sortAt: number
      try {
        sortAt = (await stat(entry.path)).mtimeMs
      } catch {
        continue
      }
      candidates.push({ provider: 'codex', id: meta.id, path: entry.path, cwd: directory, sortAt })
    }
    return candidates
  }

  async function describe(candidate: Candidate): Promise<ConversationSummary | null> {
    let mtimeMs: number
    let size: number
    try {
      const stats = await stat(candidate.path)
      mtimeMs = stats.mtimeMs
      size = stats.size
    } catch {
      // Deleted between enumeration and this read: drop it rather than report a phantom.
      return null
    }
    const cached = details.get(candidate.path)
    let detail = cached && cached.mtimeMs === mtimeMs && cached.size === size ? cached.detail : null
    if (!detail) {
      let content: string
      try {
        content = await readFile(candidate.path, 'utf8')
      } catch {
        return null
      }
      const fallback = new Date(mtimeMs).toISOString()
      detail = candidate.provider === 'claude'
        ? parseClaudeDetail(content, fallback)
        : parseCodexDetail(content, fallback)
      details.set(candidate.path, { mtimeMs, size, detail })
      trim(details)
    }
    return {
      id: candidate.id,
      provider: candidate.provider,
      path: candidate.path,
      title: detail.title,
      updatedAt: detail.updatedAt,
      messageCount: detail.messageCount,
      cwd: candidate.cwd
    }
  }

  return {
    async list(request): Promise<ConversationListPage> {
      const directories = request.directories.filter(Boolean)
      if (directories.length === 0) return { entries: [], total: 0, hasMore: false }
      const limit = Math.max(1, Math.min(request.limit ?? DEFAULT_LIMIT, 100))
      const offset = Math.max(0, request.offset ?? 0)
      const [claude, codex] = await Promise.all([
        claudeCandidates(directories),
        codexCandidates(directories)
      ])
      const candidates = [...claude, ...codex].sort((left, right) => right.sortAt - left.sortAt)
      // Only this window is parsed; the rest of a long history is never opened.
      const page = await mapLimited(candidates.slice(offset, offset + limit), describe)
      return {
        entries: page.filter((entry): entry is ConversationSummary => entry !== null),
        total: candidates.length,
        hasMore: offset + limit < candidates.length
      }
    },
    async exists(path): Promise<boolean> {
      try {
        return (await stat(path)).isFile()
      } catch {
        return false
      }
    }
  }
}

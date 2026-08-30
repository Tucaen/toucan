import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { ConversationProvider } from '../shared/conversation'
import {
  normalizeConversationTitle,
  type ConversationTitle,
  type ConversationTitleSource
} from '../shared/conversation-title'

export interface ConversationTitleStore {
  get(provider: ConversationProvider, conversationId: string): Promise<ConversationTitle | null>
  set(
    provider: ConversationProvider,
    conversationId: string,
    title: string,
    source: ConversationTitleSource
  ): Promise<ConversationTitle | null>
}

type StoredTitles = Record<string, ConversationTitle>

function key(provider: ConversationProvider, conversationId: string): string {
  return `${provider}:${conversationId}`
}

function isConversationTitle(value: unknown): value is ConversationTitle {
  if (!value || typeof value !== 'object') return false
  const title = value as Partial<ConversationTitle>
  return typeof title.title === 'string'
    && (title.source === 'generated' || title.source === 'manual')
}

export function createConversationTitleStore(path: string): ConversationTitleStore {
  let loaded: Promise<StoredTitles> | undefined
  let writes = Promise.resolve()

  const load = (): Promise<StoredTitles> => {
    loaded ??= readFile(path, 'utf8')
      .then((content) => JSON.parse(content) as unknown)
      .then((value) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
        return Object.fromEntries(Object.entries(value).filter(([, title]) => isConversationTitle(title)))
      })
      .catch(() => ({}))
    return loaded
  }

  const persist = async (titles: StoredTitles): Promise<void> => {
    await mkdir(dirname(path), { recursive: true })
    const temporary = `${path}.tmp`
    await writeFile(temporary, JSON.stringify(titles, null, 2), 'utf8')
    await rename(temporary, path)
  }

  return {
    async get(provider, conversationId) {
      return (await load())[key(provider, conversationId)] ?? null
    },
    async set(provider, conversationId, title, source) {
      const normalized = normalizeConversationTitle(title)
      if (!normalized) return null
      let result: ConversationTitle | null = null
      // A failed disk write rejects its caller, but must not poison every later attempt for the
      // rest of the app process. The next write starts again from the last readable state.
      writes = writes.catch(() => undefined).then(async () => {
        const titles = await load()
        const existing = titles[key(provider, conversationId)]
        if (existing && source === 'generated') {
          result = existing
          return
        }
        result = { title: normalized, source }
        titles[key(provider, conversationId)] = result
        await persist(titles)
      })
      await writes
      return result
    }
  }
}

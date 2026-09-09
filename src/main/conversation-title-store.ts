import type { ConversationProvider } from '../shared/conversation'
import {
  normalizeConversationTitle,
  type ConversationTitle,
  type ConversationTitleSource
} from '../shared/conversation-title'
import { createDurableJsonStore } from './durable-json-store'

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
  return typeof title.title === 'string' && (title.source === 'generated' || title.source === 'manual')
}

function parseTitles(value: unknown): StoredTitles | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return Object.fromEntries(Object.entries(value).filter(([, title]) => isConversationTitle(title)))
}

export function createConversationTitleStore(path: string): ConversationTitleStore {
  const store = createDurableJsonStore<StoredTitles>({ path, parse: parseTitles, fallback: () => ({}) })

  return {
    async get(provider, conversationId) {
      return (await store.load())[key(provider, conversationId)] ?? null
    },
    async set(provider, conversationId, title, source) {
      const normalized = normalizeConversationTitle(title)
      if (!normalized) return null
      return store.update((titles) => {
        const existing = titles[key(provider, conversationId)]
        // Generated titles are first-write-wins; only a manual rename may replace anything.
        if (existing && source === 'generated') return { value: titles, result: existing }
        const result: ConversationTitle = { title: normalized, source }
        return { value: { ...titles, [key(provider, conversationId)]: result }, result }
      })
    }
  }
}

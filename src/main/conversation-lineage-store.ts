import type { ConversationProvider } from '../shared/conversation'
import { createDurableJsonStore } from './durable-json-store'

/**
 * Which conversation each branch was forked from, recorded by Toucan when the fork reports its
 * conversation id. Codex writes the same fact into the rollout (`forked_from_id`), Claude writes
 * nothing, so this is what lets a branch reopened from History - after both nodes were closed -
 * find its parent again for either provider (#240).
 */
export interface ConversationLineageStore {
  forkedFrom(provider: ConversationProvider, conversationId: string): Promise<string | null>
  setForkedFrom(provider: ConversationProvider, conversationId: string, parentConversationId: string): Promise<void>
}

type StoredLineage = Record<string, string>

function key(provider: ConversationProvider, conversationId: string): string {
  return `${provider}:${conversationId}`
}

function parseLineage(value: unknown): StoredLineage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return Object.fromEntries(Object.entries(value).filter(([, parent]) => typeof parent === 'string' && parent))
}

export function createConversationLineageStore(
  path: string,
  log?: (message: string) => void
): ConversationLineageStore {
  const store = createDurableJsonStore<StoredLineage>({ path, parse: parseLineage, fallback: () => ({}), log })

  return {
    async forkedFrom(provider, conversationId) {
      return (await store.load())[key(provider, conversationId)] ?? null
    },
    async setForkedFrom(provider, conversationId, parentConversationId) {
      if (conversationId === parentConversationId) return
      await store.update((lineage) => ({
        value: { ...lineage, [key(provider, conversationId)]: parentConversationId },
        result: undefined
      }))
    }
  }
}

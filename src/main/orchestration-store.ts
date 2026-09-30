import { join } from 'node:path'
import type { AgentProvider } from '../shared/agent-provider'
import { isOrchestrationRecord, type OrchestrationRecord } from '../shared/orchestration'
import { createDurableJsonStore, type DurableJsonStore } from './durable-json-store'

/**
 * Where orchestration records live: one file per orchestrator conversation under
 * `<userData>\orchestrations\`, each a `durable-json-store` of its own, so a write to one
 * orchestration never rewrites another's and a damaged file costs only its own record. Keyed by
 * `(provider, conversationId)` because a resumed orchestrator is a conversation, not a canvas node.
 */
export interface OrchestrationKey {
  provider: AgentProvider
  conversationId: string
}

export interface OrchestrationStore {
  read(key: OrchestrationKey): Promise<OrchestrationRecord | undefined>
  /**
   * Queued read-modify-write on one record, serialized with every other write to it. Returning the
   * current value verbatim writes nothing, which is how a refused command leaves the file alone.
   */
  update<R>(
    key: OrchestrationKey,
    mutate: (current: OrchestrationRecord | undefined) => { value: OrchestrationRecord | undefined; result: R }
  ): Promise<R>
}

/**
 * Lossless and path-safe: every character outside `[A-Za-z0-9-]` becomes `_` plus its code point in
 * hex, so no provider id can escape the directory and two ids can never share a file.
 * @internal exported for tests
 */
export function orchestrationFileName(key: OrchestrationKey): string {
  const id = key.conversationId.replace(/[^A-Za-z0-9-]/gu, (character) => `_${character.codePointAt(0)!.toString(16)}_`)
  return `${key.provider}-${id}.json`
}

export function createOrchestrationStore(options: {
  directory: string
  log?(message: string): void
}): OrchestrationStore {
  const stores = new Map<string, DurableJsonStore<OrchestrationRecord | null>>()
  const storeFor = (key: OrchestrationKey): DurableJsonStore<OrchestrationRecord | null> => {
    const fileName = orchestrationFileName(key)
    let store = stores.get(fileName)
    if (!store) {
      store = createDurableJsonStore<OrchestrationRecord | null>({
        path: join(options.directory, fileName),
        // A file that names another conversation is not this one's record.
        parse: (value) =>
          isOrchestrationRecord(value) && value.provider === key.provider && value.conversationId === key.conversationId
            ? value
            : null,
        fallback: () => null,
        log: options.log
      })
      stores.set(fileName, store)
    }
    return store
  }
  return {
    read: async (key) => (await storeFor(key).load()) ?? undefined,
    update: (key, mutate) =>
      storeFor(key).update((current) => {
        const { value, result } = mutate(current ?? undefined)
        // `undefined` back for an absent record is "unchanged", never a write of `null`.
        return { value: value === (current ?? undefined) ? current : (value ?? null), result }
      })
  }
}

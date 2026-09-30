import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { AGENT_PROVIDERS, type AgentProvider } from '../shared/agent-provider'
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
   * Every readable record in the directory - what the routing report (#40) aggregates. A file that
   * is damaged, unreadable or not a record's name is skipped: one lost orchestration costs its own
   * numbers, never the report.
   */
  list(): Promise<OrchestrationRecord[]>
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

/** `orchestrationFileName` read back; undefined for any name it could not have produced. */
function orchestrationKeyFromFileName(name: string): OrchestrationKey | undefined {
  const match = /^([a-z]+)-((?:[A-Za-z0-9-]|_[0-9a-f]+_)+)\.json$/u.exec(name)
  const provider = AGENT_PROVIDERS.find((candidate) => candidate === match?.[1])
  if (!match?.[2] || !provider) return undefined
  const conversationId = match[2].replace(/_([0-9a-f]+)_/gu, (_, hex: string) =>
    String.fromCodePoint(parseInt(hex, 16))
  )
  return { provider, conversationId }
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
    async list() {
      let names: string[]
      try {
        names = await readdir(options.directory)
      } catch (error) {
        if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return []
        throw error
      }
      const records: OrchestrationRecord[] = []
      for (const name of names.sort()) {
        const key = orchestrationKeyFromFileName(name)
        if (!key) continue
        const record = await storeFor(key)
          .load()
          .catch(() => null)
        if (record) records.push(record)
      }
      return records
    },
    update: (key, mutate) =>
      storeFor(key).update((current) => {
        const { value, result } = mutate(current ?? undefined)
        // `undefined` back for an absent record is "unchanged", never a write of `null`.
        return { value: value === (current ?? undefined) ? current : (value ?? null), result }
      })
  }
}

import { AGENT_PROVIDERS, type AgentProvider } from '../shared/agent-provider'
import { isRecord } from '../shared/record'
import { createDurableJsonStore } from './durable-json-store'

/**
 * The efforts each model's picker was last seen to offer, per provider (#36). The effort selector
 * is advertised for the session's *current* model only, so what a model offers is known once a
 * session has run on it - and routing a ticket to a model has to settle its effort before the
 * ticket session exists. Like `agent-model-catalogue-store.ts` this is a cache presented as a
 * choice: stale until a session says otherwise, and the spawn reports what the session actually runs.
 */
export type AgentEffortCatalogue = Partial<Record<AgentProvider, Record<string, string[]>>>

export interface AgentEffortCatalogueStore {
  /** Undefined while no session has run this model; an empty list means it offers no effort. */
  efforts(provider: AgentProvider, modelId: string): readonly string[] | undefined
  record(provider: AgentProvider, modelId: string, efforts: readonly string[]): void
  /** Settles once the file has been read. */
  ready: Promise<void>
}

/** A guard against an adapter gone strange, like the model catalogue's. */
const MODEL_LIMIT = 64

function parseAgentEffortCatalogue(value: unknown): AgentEffortCatalogue | null {
  if (!isRecord(value)) return null
  const catalogue: AgentEffortCatalogue = {}
  for (const provider of AGENT_PROVIDERS) {
    const models = value[provider]
    if (!isRecord(models)) continue
    const entries = Object.entries(models)
      .filter((entry): entry is [string, string[]] => {
        const efforts = entry[1]
        return Array.isArray(efforts) && efforts.every((effort) => typeof effort === 'string')
      })
      .slice(0, MODEL_LIMIT)
    catalogue[provider] = Object.fromEntries(entries)
  }
  return catalogue
}

const sameList = (a: readonly string[] | undefined, b: readonly string[]): boolean =>
  a !== undefined && a.length === b.length && a.every((effort, index) => effort === b[index])

export function createAgentEffortCatalogueStore(options: {
  path: string
  log?: (message: string) => void
}): AgentEffortCatalogueStore {
  const store = createDurableJsonStore<AgentEffortCatalogue>({
    path: options.path,
    parse: parseAgentEffortCatalogue,
    fallback: () => ({}),
    log: options.log
  })
  // A synchronous mirror, for the same reason as the model catalogue's: a route is resolved inside
  // a request handler, and a record that landed before the first read wins over the file.
  let current: AgentEffortCatalogue = {}
  const ready = store
    .load()
    .then((loaded) => {
      for (const provider of AGENT_PROVIDERS) {
        if (loaded[provider]) current = { ...current, [provider]: { ...loaded[provider], ...current[provider] } }
      }
    })
    .catch(() => undefined)

  return {
    ready,
    efforts: (provider, modelId) =>
      Object.hasOwn(current[provider] ?? {}, modelId) ? current[provider]?.[modelId] : undefined,
    record(provider, modelId, efforts) {
      if (sameList(current[provider]?.[modelId], efforts)) return
      const list = [...efforts]
      current = { ...current, [provider]: { ...current[provider], [modelId]: list } }
      void store
        .update((stored) => ({
          value: { ...stored, [provider]: { ...stored[provider], [modelId]: list } },
          result: undefined
        }))
        .catch((error: unknown) => {
          options.log?.(`Could not record the ${provider} ${modelId} effort list: ${String(error)}`)
        })
    }
  }
}

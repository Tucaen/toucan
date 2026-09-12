import type { AgentModel } from '../shared/agent'
import type { AgentProvider } from '../shared/agent-provider'
import {
  AGENT_MODEL_CATALOGUE_LIMIT,
  parseAgentModelCatalogue,
  type AgentModelCatalogue
} from '../shared/agent-model-catalogue'
import { createDurableJsonStore } from './durable-json-store'

/**
 * The durable home of `AgentModelCatalogue` - one parse predicate and a fallback over the shared
 * JSON store, like every other simple store in main.
 *
 * Durable rather than in-memory for one reason: the surface that needs it is the phone's new-chat
 * form, and the desktop it asks may have been restarted since it last ran a session of that
 * provider. An in-memory cache would leave the picker empty exactly when a phone is most likely to
 * be reaching for it - first thing, against a desktop nobody has touched yet today.
 */
export interface AgentModelCatalogueStore {
  /** What each provider was last seen to offer. Empty until a session has advertised something. */
  read(): AgentModelCatalogue
  /**
   * Records what a session of this provider just advertised, replacing that provider's entry. A
   * list identical to the stored one costs no disk write; an empty list is ignored rather than
   * stored, since "this session reported nothing" is not evidence the provider offers nothing.
   */
  record(provider: AgentProvider, models: readonly AgentModel[]): void
}

export interface AgentModelCatalogueStoreOptions {
  path: string
  /** Injectable so a failed write can be reported rather than swallowed silently. */
  log?: (message: string) => void
}

function sameModels(a: readonly AgentModel[] | undefined, b: readonly AgentModel[]): boolean {
  if (!a || a.length !== b.length) return false
  return a.every((model, index) => {
    const other = b[index]
    return model.id === other.id && model.name === other.name && model.description === other.description
  })
}

export function createAgentModelCatalogueStore(options: AgentModelCatalogueStoreOptions): AgentModelCatalogueStore {
  const store = createDurableJsonStore<AgentModelCatalogue>({
    path: options.path,
    parse: parseAgentModelCatalogue,
    fallback: () => ({})
  })
  // Read through a synchronously-available mirror: the remote server answers a route from this and
  // an HTTP handler cannot await a first disk read without turning every cold request into a stall.
  let current: AgentModelCatalogue = {}
  void store.load().then((loaded) => {
    // A record that landed before the first read wins: it is newer than the file by construction.
    current = { ...loaded, ...current }
  })

  return {
    read: () => current,
    record(provider, models): void {
      if (models.length === 0) return
      const bounded = models.slice(0, AGENT_MODEL_CATALOGUE_LIMIT)
      if (sameModels(current[provider], bounded)) return
      current = { ...current, [provider]: bounded }
      void store.save(current).catch((error: unknown) => {
        // Losing the write costs a picker that is one restart out of date, never a broken spawn.
        options.log?.(`Could not record the ${provider} model list: ${String(error)}`)
      })
    }
  }
}

import type { AgentModel } from './agent'
import type { AgentProvider } from './agent-provider'
import { AGENT_PROVIDERS } from './agent-provider'

/**
 * The models each provider was last seen to offer, and the *only* answer available to the question
 * "what could this chat run on?" before a session exists.
 *
 * That question has no honest live answer. A model list is advertised by a running ACP session as
 * its `model` config option, so nothing knows what Claude offers until a Claude session has opened.
 * Codex has a cache on disk (`readCachedCodexModels`); Claude has nothing at all. Rather than give
 * one provider a picker and the other none, the desktop *remembers*: every session that advertises
 * models records them here, and a surface that has to choose a model up front - the phone's new-chat
 * form - is offered what was last advertised.
 *
 * Two consequences are worth stating plainly, because this is a cache presented as a choice:
 *
 * - It is **empty until a session of that provider has run** on this desktop. A caller must render
 *   "no list yet" rather than an empty picker, and must stay usable with no model named at all -
 *   omitting one is always valid and means "whatever the desktop would have picked".
 * - It can be **stale**. A provider that retires a model leaves it listed here until the next
 *   session says otherwise, so the id a caller sends is a request, not a guarantee; the session
 *   manager is what ultimately accepts or refuses it.
 *
 * It holds no current selection on purpose. Which model a *conversation* is on belongs to that
 * conversation (`AgentModelState.currentModelId`); this is only the menu.
 */
export type AgentModelCatalogue = Partial<Record<AgentProvider, AgentModel[]>>

/** How many models one provider may contribute. Generous; a guard against an adapter gone strange. */
export const AGENT_MODEL_CATALOGUE_LIMIT = 64

function isModel(value: unknown): value is AgentModel {
  if (!value || typeof value !== 'object') return false
  const model = value as Partial<AgentModel>
  return (
    typeof model.id === 'string' &&
    model.id.length > 0 &&
    typeof model.name === 'string' &&
    (model.description === undefined || typeof model.description === 'string')
  )
}

/**
 * Reads one catalogue off disk or off the wire. Damaged entries are dropped individually rather
 * than taking the readable providers with them: this is a convenience cache, so the worst outcome
 * of a bad entry should be one missing picker, never a refused spawn.
 */
export function parseAgentModelCatalogue(value: unknown): AgentModelCatalogue | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const catalogue: AgentModelCatalogue = {}
  for (const provider of AGENT_PROVIDERS) {
    const models = (value as Record<string, unknown>)[provider]
    if (!Array.isArray(models)) continue
    const valid = models.filter(isModel).slice(0, AGENT_MODEL_CATALOGUE_LIMIT)
    if (valid.length > 0) catalogue[provider] = valid
  }
  return catalogue
}

/** Whether this provider is known to offer this model. An unknown provider offers nothing. */
export function catalogueOffers(catalogue: AgentModelCatalogue, provider: AgentProvider, modelId: string): boolean {
  return (catalogue[provider] ?? []).some((model) => model.id === modelId)
}

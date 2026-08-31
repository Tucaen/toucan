import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentModel, AgentModelState } from '../shared/agent'

interface CachedCodexModel {
  slug?: unknown
  display_name?: unknown
  description?: unknown
  visibility?: unknown
}

/** Model discovery does not require an authenticated ACP session when Codex has a local cache. */
export function readCachedCodexModels(codexHome: string, selectedId?: string): AgentModelState | undefined {
  try {
    const cache = JSON.parse(readFileSync(join(codexHome, 'models_cache.json'), 'utf8')) as {
      models?: unknown
    }
    if (!Array.isArray(cache.models)) return undefined
    const availableModels = cache.models.flatMap((entry): AgentModel[] => {
      const model = entry as CachedCodexModel
      if (model.visibility !== 'list' || typeof model.slug !== 'string' || typeof model.display_name !== 'string')
        return []
      return [
        {
          id: model.slug,
          name: model.display_name,
          ...(typeof model.description === 'string' && model.description ? { description: model.description } : {})
        }
      ]
    })
    if (availableModels.length === 0) return undefined
    return {
      currentModelId: availableModels.some((model) => model.id === selectedId) ? selectedId! : availableModels[0].id,
      availableModels
    }
  } catch {
    return undefined
  }
}

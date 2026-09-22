import type { SessionConfigOption } from '@agentclientprotocol/sdk'
import type { AgentModelState } from './agent'
import { selectorFromConfigOptions } from './agent-session-config'

export interface AgentModelSelector {
  /** The ACP config option to write back through `session/set_config_option`. */
  configId: string
  models: AgentModelState
}

/** Read the model choice out of an ACP session's config options, ignoring the other selectors. */
export function modelSelectorFromConfigOptions(
  configOptions: SessionConfigOption[] | null | undefined
): AgentModelSelector | undefined {
  // ACP treats `category` as a UX hint an agent may omit, so fall back to the conventional id.
  const selector = selectorFromConfigOptions(
    configOptions,
    (option) => option.category === 'model' || option.id === 'model'
  )
  if (!selector) return undefined
  return {
    configId: selector.configId,
    models: { currentModelId: selector.currentId, availableModels: selector.options }
  }
}

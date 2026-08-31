import type { SessionConfigOption, SessionConfigSelectOption } from '@agentclientprotocol/sdk'
import type { AgentModelState } from './agent'

export interface AgentModelSelector {
  /** The ACP config option to write back through `session/set_config_option`. */
  configId: string
  models: AgentModelState
}

type SelectConfigOption = Extract<SessionConfigOption, { type: 'select' }>

function isModelSelector(option: SessionConfigOption): option is SelectConfigOption {
  // ACP treats `category` as a UX hint an agent may omit, so fall back to the conventional id.
  return option.type === 'select' && (option.category === 'model' || option.id === 'model')
}

function selectableOptions(option: SelectConfigOption): SessionConfigSelectOption[] {
  return option.options.flatMap((entry) => ('group' in entry ? entry.options : [entry]))
}

/** Read the model choice out of an ACP session's config options, ignoring the other selectors. */
export function modelSelectorFromConfigOptions(
  configOptions: SessionConfigOption[] | null | undefined
): AgentModelSelector | undefined {
  const option = configOptions?.find(isModelSelector)
  if (!option) return undefined
  const availableModels = selectableOptions(option).map((model) => ({
    id: model.value,
    name: model.name,
    ...(model.description ? { description: model.description } : {})
  }))
  if (availableModels.length === 0) return undefined
  return {
    configId: option.id,
    models: { currentModelId: option.currentValue, availableModels }
  }
}

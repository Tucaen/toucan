import type { SessionConfigOption, SessionConfigSelectOption } from '@agentclientprotocol/sdk'
import type { AgentEffortState } from './agent'

export interface AgentEffortSelector {
  /** The ACP config option to write back through `session/set_config_option`. */
  configId: string
  efforts: AgentEffortState
}

type SelectConfigOption = Extract<SessionConfigOption, { type: 'select' }>

function selectableOptions(option: SelectConfigOption): SessionConfigSelectOption[] {
  return option.options.flatMap((entry) => ('group' in entry ? entry.options : [entry]))
}

/** Reads the provider/model-specific thought-level selector advertised by the active ACP session. */
export function effortSelectorFromConfigOptions(
  configOptions: SessionConfigOption[] | null | undefined
): AgentEffortSelector | undefined {
  const option = configOptions?.find(
    (candidate): candidate is SelectConfigOption =>
      candidate.type === 'select' && candidate.category === 'thought_level'
  )
  if (!option) return undefined
  const availableEfforts = selectableOptions(option).map((effort) => ({
    id: effort.value,
    name: effort.name,
    ...(effort.description ? { description: effort.description } : {})
  }))
  if (availableEfforts.length === 0) return undefined
  return {
    configId: option.id,
    efforts: { currentEffortId: option.currentValue, availableEfforts }
  }
}

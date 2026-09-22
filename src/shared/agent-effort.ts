import type { SessionConfigOption } from '@agentclientprotocol/sdk'
import type { AgentEffortState } from './agent'
import { selectorFromConfigOptions } from './agent-session-config'

export interface AgentEffortSelector {
  /** The ACP config option to write back through `session/set_config_option`. */
  configId: string
  efforts: AgentEffortState
}

/** Reads the provider/model-specific thought-level selector advertised by the active ACP session. */
export function effortSelectorFromConfigOptions(
  configOptions: SessionConfigOption[] | null | undefined
): AgentEffortSelector | undefined {
  const selector = selectorFromConfigOptions(configOptions, (option) => option.category === 'thought_level')
  if (!selector) return undefined
  return {
    configId: selector.configId,
    efforts: { currentEffortId: selector.currentId, availableEfforts: selector.options }
  }
}

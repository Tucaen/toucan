/**
 * The one reader of an ACP session's `configOptions`. Models and effort levels are the same
 * protocol shape - a `select` whose options may be flat or grouped - and differ only in which
 * option a caller wants, so that difference is a predicate rather than a second copy of the
 * flattening and the empty-options refusal.
 */
import type { SessionConfigOption, SessionConfigSelectOption } from '@agentclientprotocol/sdk'
import type { AgentOption } from './agent'

export type SelectConfigOption = Extract<SessionConfigOption, { type: 'select' }>

export interface AgentConfigSelector {
  /** The ACP config option to write back through `session/set_config_option`. */
  configId: string
  /** Which option the session is on right now. */
  currentId: string
  options: AgentOption[]
}

function selectableOptions(option: SelectConfigOption): SessionConfigSelectOption[] {
  return option.options.flatMap((entry) => ('group' in entry ? entry.options : [entry]))
}

/**
 * The first `select` option `wanted` accepts, flattened into choices a picker can render. A
 * selector with no options at all is `undefined` rather than an empty one: a picker with nothing
 * to pick is a control that can only mislead.
 */
export function selectorFromConfigOptions(
  configOptions: SessionConfigOption[] | null | undefined,
  wanted: (option: SelectConfigOption) => boolean
): AgentConfigSelector | undefined {
  const option = configOptions?.find(
    (candidate): candidate is SelectConfigOption => candidate.type === 'select' && wanted(candidate)
  )
  if (!option) return undefined
  const options = selectableOptions(option).map((entry) => ({
    id: entry.value,
    name: entry.name,
    ...(entry.description ? { description: entry.description } : {})
  }))
  if (options.length === 0) return undefined
  return { configId: option.id, currentId: option.currentValue, options }
}

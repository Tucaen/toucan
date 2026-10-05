import type { PickerOption } from './SelectorPicker'
import type { AgentProvider } from '../../shared/agent-provider'

/**
 * The providers whose sessions carry a command guard: both register a `PreToolUse` hook, Claude
 * through its session settings (ticket 01) and Codex through its launch (ticket 02). A provider
 * added later gets no switch until its guard exists.
 */
const GUARDED_PROVIDERS: readonly AgentProvider[] = ['claude', 'codex']

export const COMMAND_GUARD_ON_OPTION: PickerOption = {
  id: 'on',
  name: 'Command guard on',
  description: 'Block dangerous shell commands in this conversation'
}

export const COMMAND_GUARD_OFF_OPTION: PickerOption = {
  id: 'off',
  name: 'Command guard off',
  description: 'Let this conversation run any shell command'
}

export interface CommandGuardDisplay {
  options: PickerOption[]
  selectedId: string
  /** False when the switch cannot be changed: the guard is off for every chat. */
  changeable: boolean
  note: string
}

/** Null where the provider has no guard, so the menu shows no switch that would do nothing. */
export function describeCommandGuard(
  provider: AgentProvider,
  nodeEnabled: boolean,
  globallyOff: boolean
): CommandGuardDisplay | null {
  if (!GUARDED_PROVIDERS.includes(provider)) return null
  if (globallyOff) {
    return {
      options: [COMMAND_GUARD_OFF_OPTION],
      selectedId: COMMAND_GUARD_OFF_OPTION.id,
      changeable: false,
      note: 'The command guard is off for every conversation. Turn it back on in the global command guard settings.'
    }
  }
  return {
    options: [COMMAND_GUARD_ON_OPTION, COMMAND_GUARD_OFF_OPTION],
    selectedId: nodeEnabled ? COMMAND_GUARD_ON_OPTION.id : COMMAND_GUARD_OFF_OPTION.id,
    changeable: true,
    note: 'Applies when this conversation next starts or resumes. Requested, not confirmed.'
  }
}

import { AtSign, BrainCircuit, ChevronDown, Cpu, Keyboard, Pencil, Scale, ShieldCheck, UsersRound } from 'lucide-react'
import { ListboxPicker } from './ListboxPicker'

export interface PickerOption {
  id: string
  name: string
  description?: string
  /**
   * A single option that cannot be chosen while the rest of the menu stays usable - the picker's
   * own trigger stays open, because opening is what re-checks whatever closed this option.
   */
  disabled?: boolean
}

export const pickerCopy = {
  provider: { icon: AtSign, heading: 'Provider', idle: 'Provider', hint: 'Choose the agent provider' },
  permission: {
    icon: ShieldCheck,
    heading: 'Permission mode',
    idle: 'Permissions',
    hint: 'Set the permission mode for this agent'
  },
  model: { icon: Cpu, heading: 'Model', idle: 'Model', hint: 'Choose the model for this conversation' },
  effort: {
    icon: BrainCircuit,
    heading: 'Thinking effort',
    idle: 'Effort',
    hint: 'Set the thinking effort for this conversation'
  },
  sendKey: { icon: Keyboard, heading: 'Send with', idle: 'Send key', hint: 'Choose which key sends a message' },
  delegation: {
    icon: UsersRound,
    heading: 'Routine work',
    idle: 'Delegation',
    hint: 'Delegate routine work to an economical worker model'
  },
  decisions: {
    icon: Scale,
    heading: 'Decisions',
    idle: 'Decisions',
    hint: 'Let decision-shaped subtasks go to an installed decision-provider skill'
  },
  cleanup: {
    icon: Pencil,
    heading: 'Dictation cleanup',
    idle: 'Cleanup',
    hint: 'Polish dictation using your Claude subscription'
  }
} as const

/**
 * One dropdown shape for every agent-reported selector, so modes and models stay consistent.
 * The popup itself - portal, position, keyboard model - is `ListboxPicker`; this wrapper only
 * knows the composer's copy table and trigger chrome.
 */
export function SelectorPicker(props: {
  kind: keyof typeof pickerCopy
  options: PickerOption[]
  selectedId?: string
  disabled: boolean
  /** Why it is closed, when there is a reason worth reading. Outranks the usual hover text. */
  disabledHint?: string
  /** Fired each time the menu is opened, for options whose availability can go stale. */
  onOpen?(): void
  select(optionId: string): void
}): JSX.Element {
  const copy = pickerCopy[props.kind]
  const PickerIcon = copy.icon
  const selected = props.options.find((option) => option.id === props.selectedId)
  const canOpen = props.options.length > 0 && !props.disabled

  return (
    <ListboxPicker
      options={props.options.map((option) => ({
        id: option.id,
        content: option.name,
        description: option.description,
        selected: option.id === props.selectedId,
        disabled: option.disabled
      }))}
      heading={copy.heading}
      menuWidth={230}
      containerClassName="node-picker nodrag"
      containerData={{ 'data-picker': props.kind }}
      trigger={{
        className: 'node-picker-button',
        title: props.disabledHint ?? selected?.description ?? selected?.name ?? copy.hint,
        disabled: !canOpen,
        content: (
          <>
            <PickerIcon aria-hidden="true" />
            {selected?.name ?? copy.idle}
            <ChevronDown aria-hidden="true" />
          </>
        )
      }}
      onOpen={props.onOpen}
      select={props.select}
    />
  )
}

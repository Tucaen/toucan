import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  AtSign,
  BrainCircuit,
  Check,
  ChevronDown,
  Cpu,
  Keyboard,
  Pencil,
  Scale,
  ShieldCheck,
  UsersRound
} from 'lucide-react'
import { usePortalMenuPosition } from './use-portal-menu-position'

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

/** One dropdown shape for every agent-reported selector, so modes and models stay consistent. */
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
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const copy = pickerCopy[props.kind]
  const PickerIcon = copy.icon
  const selected = props.options.find((option) => option.id === props.selectedId)
  const canOpen = props.options.length > 0 && !props.disabled

  // The menu portals to <body> so it can escape ancestors (e.g. canvas nodes) that clip overflow.
  const menuPosition = usePortalMenuPosition(
    buttonRef,
    menuRef,
    open,
    { width: 230, height: 0 },
    undefined,
    props.options
  )

  const closeUnlessFocusStaysInside = (relatedTarget: EventTarget | null): void => {
    const next = relatedTarget as Node | null
    if (containerRef.current?.contains(next) || menuRef.current?.contains(next)) return
    setOpen(false)
  }

  const menu = open && (
    <div
      ref={menuRef}
      className="node-picker-menu"
      role="listbox"
      aria-label={copy.heading}
      style={{
        position: 'fixed',
        top: menuPosition?.top ?? 0,
        left: menuPosition?.left ?? 0,
        visibility: menuPosition ? 'visible' : 'hidden'
      }}
      onBlur={(event) => closeUnlessFocusStaysInside(event.relatedTarget)}
      onClick={(event) => event.stopPropagation()}
    >
      <small>{copy.heading}</small>
      {props.options.map((option) => (
        <button
          type="button"
          role="option"
          aria-selected={option.id === props.selectedId}
          data-selected={option.id === props.selectedId}
          // Closed on its own, with the rest of the menu still usable. No hover text: the reason
          // travels in the option's description, which is rendered below as visible text.
          disabled={option.disabled}
          key={option.id}
          onClick={() => {
            props.select(option.id)
            setOpen(false)
          }}
        >
          <strong>
            {option.name}
            {option.id === props.selectedId && <Check className="node-picker-selected-marker" aria-hidden="true" />}
          </strong>
          {option.description && <span>{option.description}</span>}
        </button>
      ))}
    </div>
  )

  return (
    <div
      ref={containerRef}
      className="node-picker nodrag"
      data-picker={props.kind}
      onBlur={(event) => closeUnlessFocusStaysInside(event.relatedTarget)}
      onClick={(event) => event.stopPropagation()}
    >
      <button
        ref={buttonRef}
        type="button"
        className="node-picker-button"
        aria-expanded={open}
        aria-haspopup="listbox"
        disabled={!canOpen}
        title={props.disabledHint ?? selected?.description ?? selected?.name ?? copy.hint}
        onClick={() =>
          setOpen((current) => {
            if (!current) props.onOpen?.()
            return !current
          })
        }
      >
        <PickerIcon aria-hidden="true" />
        {selected?.name ?? copy.idle}
        <ChevronDown aria-hidden="true" />
      </button>
      {menu && createPortal(menu, document.body)}
    </div>
  )
}

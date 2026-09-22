import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { Check } from 'lucide-react'
import { usePortalMenuPosition } from './use-portal-menu-position'
import { useMenuNavigation, useOutsidePointerClose } from './menu-keyboard'

/**
 * The one popup-listbox implementation (#231): a trigger button that opens a portalled
 * `role="listbox"` menu, positioned in viewport coordinates so it can escape overflow-clipping
 * ancestors, with the shared keyboard contract - focus moves to the selected option on open,
 * arrows and Home/End rove, Escape closes and returns focus to the trigger, and focus leaving
 * both trigger and menu closes it. `SelectorPicker` (the composer pickers) and
 * `BrainDumpProjectPicker` (the topic chip) are thin skins over this; a third popup listbox
 * should be too.
 */

export interface ListboxPickerOption {
  id: string
  /** Rendered inside the option's `<strong>`; the Check marker is appended when selected. */
  content: ReactNode
  /** Visible secondary line; also where a disabled option explains itself. */
  description?: ReactNode
  selected: boolean
  /**
   * A single option that cannot be chosen while the rest of the menu stays usable - the picker's
   * own trigger stays open, because opening is what re-checks whatever closed this option.
   */
  disabled?: boolean
}

export interface ListboxPickerProps {
  options: readonly ListboxPickerOption[]
  /** The menu's `<small>` heading and, unless overridden, its accessible name. */
  heading: string
  menuAriaLabel?: string
  menuClassName?: string
  menuWidth: number
  align?: 'start'
  container?: 'div' | 'span'
  containerClassName?: string
  /** Extra attributes on the container (e.g. `data-picker`). */
  containerData?: Record<string, string | undefined>
  trigger: {
    content: ReactNode
    className?: string
    title?: string
    disabled?: boolean
    /** Extra attributes on the trigger button (e.g. `data-unassigned`). */
    data?: Record<string, string | undefined>
  }
  /** Fired each time the menu is opened, for options whose availability can go stale. */
  onOpen?(): void
  /** Any change opens the menu and focuses the trigger; how another surface reaches this picker. */
  openSignal?: number
  select(optionId: string): void
  /** Rendered after the trigger, inside the container (notes, inline errors). */
  children?: ReactNode
}

export function ListboxPicker(props: ListboxPickerProps): JSX.Element {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  const menuPosition = usePortalMenuPosition(
    buttonRef,
    menuRef,
    open,
    { width: props.menuWidth, height: 0 },
    props.align ? { align: props.align } : undefined,
    props.options
  )

  const { openSignal, onOpen } = props
  useEffect(() => {
    if (openSignal === undefined) return
    onOpen?.()
    setOpen(true)
    buttonRef.current?.focus()
  }, [onOpen, openSignal])

  const close = (refocus: boolean): void => {
    setOpen(false)
    if (refocus) buttonRef.current?.focus()
  }

  const navigation = useMenuNavigation(menuRef, open, {
    focusOnOpen: true,
    onClose: () => close(true)
  })

  // Blur close covers focus leaving; this covers a pointer-down that moves no focus at all.
  useOutsidePointerClose([containerRef, menuRef], open, () => setOpen(false))

  const closeUnlessFocusStaysInside = (relatedTarget: EventTarget | null): void => {
    const next = relatedTarget as Node | null
    if (containerRef.current?.contains(next) || menuRef.current?.contains(next)) return
    setOpen(false)
  }

  const menu = open && (
    <div
      ref={menuRef}
      className={props.menuClassName ? `node-picker-menu ${props.menuClassName}` : 'node-picker-menu'}
      role="listbox"
      aria-label={props.menuAriaLabel ?? props.heading}
      style={{
        position: 'fixed',
        top: menuPosition?.top ?? 0,
        left: menuPosition?.left ?? 0,
        visibility: menuPosition ? 'visible' : 'hidden'
      }}
      onBlur={(event) => closeUnlessFocusStaysInside(event.relatedTarget)}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={navigation.onKeyDown}
    >
      <small>{props.heading}</small>
      {props.options.map((option) => (
        <button
          type="button"
          role="option"
          aria-selected={option.selected}
          data-selected={option.selected}
          disabled={option.disabled}
          key={option.id}
          onClick={() => {
            props.select(option.id)
            close(true)
          }}
        >
          <strong>
            {option.content}
            {option.selected && <Check className="node-picker-selected-marker" aria-hidden="true" />}
          </strong>
          {option.description && <span>{option.description}</span>}
        </button>
      ))}
    </div>
  )

  const Container = props.container ?? 'div'
  return (
    <Container
      // The ref element is a div or a span; both satisfy the HTMLElement the hooks need.
      ref={containerRef as RefObject<HTMLDivElement & HTMLSpanElement>}
      className={props.containerClassName}
      {...props.containerData}
      onBlur={(event) => closeUnlessFocusStaysInside(event.relatedTarget)}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || !open) return
        event.stopPropagation()
        close(true)
      }}
    >
      <button
        ref={buttonRef}
        type="button"
        className={props.trigger.className}
        aria-expanded={open}
        aria-haspopup="listbox"
        disabled={props.trigger.disabled}
        title={props.trigger.title}
        {...props.trigger.data}
        onClick={() =>
          setOpen((current) => {
            if (!current) props.onOpen?.()
            return !current
          })
        }
      >
        {props.trigger.content}
      </button>
      {props.children}
      {menu && createPortal(menu, document.body)}
    </Container>
  )
}

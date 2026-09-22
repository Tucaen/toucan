import { useEffect, useRef, type ReactNode, type RefObject } from 'react'

/**
 * The one modal policy every overlay dialog goes through: focus moves into the dialog on open,
 * Tab cycles inside it, Escape closes it, and closing hands focus back to whatever opened it.
 * Before this shell existed the ten dialogs had four different focus policies between them (#231),
 * which is exactly the kind of drift a modal must not have - a dialog the keyboard can fall out
 * of is a dialog only the mouse can use.
 *
 * The shell owns the `.dialog-overlay` element and its ARIA; callers keep their own `.dialog`
 * body. Escape is the `onClose` prop and nothing else - a caller with a mutation in flight passes
 * `undefined` and the dialog becomes undismissable, the same gate its Cancel button already has.
 */
export interface ModalDialogProps {
  /** `alertdialog` for confirmations whose only reading is the question; `dialog` otherwise. */
  role?: 'dialog' | 'alertdialog'
  /** Id of the element naming the dialog; every dialog must have one. */
  labelledBy: string
  /** Closes on Escape. Omit to make Escape inert (e.g. while a mutation is pending). */
  onClose?: () => void
  /**
   * Focused when the dialog opens. Without it the first focusable control takes focus - unless
   * something inside the dialog (an `autoFocus` input) already claimed it during mount, which the
   * shell respects rather than overrides.
   */
  initialFocus?: RefObject<HTMLElement>
  /** Extra class on the overlay, beside `dialog-overlay`. */
  className?: string
  children: ReactNode
}

/**
 * What Tab may land on. Disabled controls are skipped; `tabindex="-1"` marks the programmatic
 * focus targets (the overlay itself, scroll panes) that the cycle must not stop on.
 */
const FOCUSABLE =
  'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'

export function ModalDialog(props: ModalDialogProps): JSX.Element {
  const overlay = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const previousFocus = document.activeElement
    const dialog = overlay.current
    if (dialog && !dialog.contains(document.activeElement)) {
      const target = props.initialFocus?.current ?? dialog.querySelector<HTMLElement>(FOCUSABLE) ?? dialog
      target.focus()
    }
    return () => {
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus()
    }
    // Mount-only on purpose: focus moves in once per dialog, not once per initialFocus identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div
      ref={overlay}
      className={props.className ? `dialog-overlay ${props.className}` : 'dialog-overlay'}
      role={props.role ?? 'dialog'}
      aria-modal="true"
      aria-labelledby={props.labelledBy}
      tabIndex={-1}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        // Nothing typed into a modal is a canvas shortcut.
        event.stopPropagation()
        if (event.key === 'Escape') {
          props.onClose?.()
          return
        }
        if (event.key !== 'Tab') return
        const controls = [...(overlay.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])]
        const first = controls[0]
        const last = controls.at(-1)
        if (!first || !last) {
          event.preventDefault()
          return
        }
        if (event.shiftKey && (document.activeElement === first || document.activeElement === overlay.current)) {
          event.preventDefault()
          last.focus()
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault()
          first.focus()
        }
      }}
    >
      {props.children}
    </div>
  )
}

import { useEffect, type KeyboardEvent, type RefObject } from 'react'

/**
 * The one keyboard model every menu, popup listbox, tablist and static listbox shares (#231):
 * arrows move a roving focus, Home/End jump, Escape closes. The WAI-ARIA Authoring Practices
 * shape, stated once as a pure rule plus two hooks, so a new floating menu adopts the contract
 * instead of re-deriving a fifth variant of it.
 */

/** What the composite widgets consider an item; disabled entries are skipped at focus time. */
const ITEM_SELECTOR =
  '[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], [role="option"], [role="tab"]'

export type MenuOrientation = 'vertical' | 'horizontal'

/**
 * Where a navigation key moves the roving focus: the next index, wrapping at the ends, or `null`
 * for a key the widget does not own. `current` is -1 when nothing inside has focus yet, so the
 * first arrow lands on the first (or last) item rather than skipping it.
 *
 * @internal exported for tests
 */
export function menuTargetIndex(
  count: number,
  current: number,
  key: string,
  orientation: MenuOrientation = 'vertical'
): number | null {
  if (count === 0) return null
  const forward = orientation === 'vertical' ? 'ArrowDown' : 'ArrowRight'
  const backward = orientation === 'vertical' ? 'ArrowUp' : 'ArrowLeft'
  if (key === 'Home') return 0
  if (key === 'End') return count - 1
  if (key === forward) return current < 0 ? 0 : (current + 1) % count
  if (key === backward) return current < 0 ? count - 1 : (current - 1 + count) % count
  return null
}

function items(container: HTMLElement | null): HTMLElement[] {
  return [...(container?.querySelectorAll<HTMLElement>(ITEM_SELECTOR) ?? [])].filter(
    (item) => !item.hasAttribute('disabled') && item.getAttribute('aria-disabled') !== 'true'
  )
}

export interface MenuNavigation {
  /** Spread onto the widget container; arrows/Home/End rove, Escape calls `onClose`. */
  onKeyDown(event: KeyboardEvent): void
}

/**
 * Keyboard behaviour for a composite widget rooted at `ref`. `open` gates the focus-on-open
 * effect for popups that stay mounted while closed; a widget that is always open passes `true`,
 * and a menu whose items are swapped in place (a paged context menu) passes a token that changes
 * with the page, so each page gets its own focus-in. `onMove` lets tab-like widgets select what
 * the arrow focused; without it, moving is focus only and activation stays with Enter/Space on
 * the item itself.
 */
export function useMenuNavigation(
  ref: RefObject<HTMLElement>,
  open: unknown,
  options: {
    orientation?: MenuOrientation
    /** Move focus to the selected item (else the first) when the widget opens. */
    focusOnOpen?: boolean
    /** Escape, when the widget is a popup that closes. */
    onClose?(): void
    /** Fired with the item the arrow landed on, for selection-follows-focus widgets. */
    onMove?(item: HTMLElement): void
  } = {}
): MenuNavigation {
  const { focusOnOpen, onClose, onMove, orientation } = options

  useEffect(() => {
    if (!open || !focusOnOpen) return
    // Runs after this render's items are in the DOM, so a page swap focuses the new page's first
    // item rather than a button that is about to unmount.
    const candidates = items(ref.current)
    const selected = candidates.find(
      (item) => item.getAttribute('aria-selected') === 'true' || item.getAttribute('aria-checked') === 'true'
    )
    ;(selected ?? candidates[0])?.focus()
  }, [focusOnOpen, open, ref])

  return {
    onKeyDown(event) {
      if (event.key === 'Escape') {
        if (!onClose) return
        event.stopPropagation()
        onClose()
        return
      }
      const candidates = items(ref.current)
      const current = candidates.indexOf(event.target as HTMLElement)
      const target = menuTargetIndex(candidates.length, current, event.key, orientation)
      if (target === null) return
      event.preventDefault()
      event.stopPropagation()
      const item = candidates[target]
      item.focus()
      onMove?.(item)
    }
  }
}

/**
 * Closes a popup when a pointer goes down outside every ref it names. Capture phase, so a click
 * that an inner handler swallows still counts as the world being touched.
 */
export function useOutsidePointerClose(
  refs: readonly RefObject<HTMLElement>[],
  open: boolean,
  onClose: () => void
): void {
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent): void => {
      if (refs.some((ref) => ref.current?.contains(event.target as Node))) return
      onClose()
    }
    window.addEventListener('pointerdown', onPointerDown, true)
    return () => window.removeEventListener('pointerdown', onPointerDown, true)
    // The refs array is a literal at every call site; its entries are stable ref objects.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, onClose])
}

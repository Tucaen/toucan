import { useLayoutEffect, useState, type RefObject } from 'react'
import {
  computeNodePickerMenuPosition,
  type NodePickerMenuOptions,
  type NodePickerMenuSize
} from './node-picker-menu-position'

/**
 * Keeps a portal-rendered menu glued to its trigger. Menus that live inside a container which
 * clips overflow - a canvas node, a scrolling list - have to be portalled to `<body>` and placed
 * in viewport coordinates instead, which means nothing in CSS keeps them with their anchor; this
 * hook is that missing link, re-measuring on resize, on any ancestor scroll, and whenever the
 * anchor itself changes size.
 *
 * Returns `null` until the first measurement, so a caller can render the menu hidden and let it
 * appear only once it is in the right place.
 */
export function usePortalMenuPosition(
  anchorRef: RefObject<HTMLElement>,
  menuRef: RefObject<HTMLElement>,
  enabled: boolean,
  fallback: NodePickerMenuSize,
  options?: NodePickerMenuOptions,
  // Anything that can change the menu's own size (its option list, say) and so its placement.
  remeasureOn?: unknown
): { top: number; left: number } | null {
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null)

  useLayoutEffect(() => {
    if (!enabled) {
      setPosition(null)
      return
    }
    const reposition = (): void => {
      const anchor = anchorRef.current?.getBoundingClientRect()
      if (!anchor) return
      const menu = menuRef.current?.getBoundingClientRect()
      setPosition(
        computeNodePickerMenuPosition(
          anchor,
          { width: menu?.width || fallback.width, height: menu?.height ?? fallback.height },
          { width: window.innerWidth, height: window.innerHeight },
          options
        )
      )
    }
    reposition()
    window.addEventListener('resize', reposition)
    window.addEventListener('scroll', reposition, true)
    // The anchor can change size without the window doing anything - a composer growing with its
    // draft, a node dragged by its resize border - and the menu has to follow it.
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(reposition) : null
    if (anchorRef.current) observer?.observe(anchorRef.current)
    return () => {
      window.removeEventListener('resize', reposition)
      window.removeEventListener('scroll', reposition, true)
      observer?.disconnect()
    }
    // `fallback` and `options` are object literals at every call site, so listing them would tear
    // down and re-attach the listeners and the ResizeObserver on every render. `reposition` reads
    // both at measure time, so the current values are always the ones used.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchorRef, enabled, menuRef, remeasureOn])

  return position
}

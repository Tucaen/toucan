import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Copy } from 'lucide-react'
import { computeNodePickerMenuPosition } from './node-picker-menu-position'
import { useMenuNavigation, useOutsidePointerClose } from './menu-keyboard'
import type { LinkCopyChoice } from './markdown-link-action'

/**
 * The right-click menu on a link in agent prose: copy what the link points at. It portals to
 * `<body>` like every other floating menu, because a canvas node clips its overflow, and is
 * placed at the pointer in viewport coordinates.
 */
export default function LinkContextMenu(props: {
  x: number
  y: number
  choices: readonly LinkCopyChoice[]
  onCopy(text: string): void
  onClose(): void
}): JSX.Element {
  const { onClose } = props
  const menuRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null)

  useLayoutEffect(() => {
    const menu = menuRef.current?.getBoundingClientRect()
    setPosition(
      computeNodePickerMenuPosition(
        { top: props.y, bottom: props.y, left: props.x, right: props.x },
        { width: menu?.width || 244, height: menu?.height ?? 0 },
        { width: window.innerWidth, height: window.innerHeight },
        { align: 'start', gap: 0 }
      )
    )
  }, [props.x, props.y])

  useOutsidePointerClose([menuRef], true, onClose)
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])
  const navigation = useMenuNavigation(menuRef, true, { focusOnOpen: true, onClose })

  return createPortal(
    <div
      ref={menuRef}
      className="context-menu link-context-menu"
      role="menu"
      aria-label="Link options"
      style={{
        position: 'fixed',
        left: position?.left ?? props.x,
        top: position?.top ?? props.y,
        visibility: position ? 'visible' : 'hidden'
      }}
      onClick={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
      // The menu sits inside a canvas node in the React tree, so its keys must not reach the
      // node's own shortcuts on the way up.
      onKeyDown={(event) => {
        navigation.onKeyDown(event)
        event.stopPropagation()
      }}
    >
      {props.choices.map((choice) => (
        <button
          key={choice.label}
          type="button"
          role="menuitem"
          onClick={() => {
            props.onCopy(choice.text)
            onClose()
          }}
        >
          <span className="menu-icon">
            <Copy aria-hidden="true" />
          </span>
          <span>
            <strong>{choice.label}</strong>
            <small className="link-context-menu-target">{choice.text}</small>
          </span>
        </button>
      ))}
    </div>,
    document.body
  )
}

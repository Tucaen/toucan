import { fireEvent, render, screen } from '@testing-library/react'
import { useRef, useState } from 'react'
import assert from 'node:assert/strict'
import { describe, expect, it, vi } from 'vitest'
import { menuTargetIndex, useMenuNavigation, useOutsidePointerClose } from '../src/renderer/src/menu-keyboard'

/** The shared WAI-ARIA keyboard model (#231): the pure rule, then the hooks over a live widget. */

describe('menuTargetIndex', () => {
  it('walks forward and backward with wrap-around', () => {
    assert.equal(menuTargetIndex(3, 0, 'ArrowDown'), 1)
    assert.equal(menuTargetIndex(3, 2, 'ArrowDown'), 0)
    assert.equal(menuTargetIndex(3, 0, 'ArrowUp'), 2)
    assert.equal(menuTargetIndex(3, 1, 'ArrowUp'), 0)
  })

  it('uses the horizontal arrows when the widget says so', () => {
    assert.equal(menuTargetIndex(2, 0, 'ArrowRight', 'horizontal'), 1)
    assert.equal(menuTargetIndex(2, 0, 'ArrowLeft', 'horizontal'), 1)
    assert.equal(menuTargetIndex(2, 0, 'ArrowDown', 'horizontal'), null)
  })

  it('enters at the first item forward and the last item backward when nothing has focus', () => {
    assert.equal(menuTargetIndex(3, -1, 'ArrowDown'), 0)
    assert.equal(menuTargetIndex(3, -1, 'ArrowUp'), 2)
  })

  it('jumps with Home and End, and owns nothing else', () => {
    assert.equal(menuTargetIndex(3, 1, 'Home'), 0)
    assert.equal(menuTargetIndex(3, 1, 'End'), 2)
    assert.equal(menuTargetIndex(3, 1, 'Enter'), null)
    assert.equal(menuTargetIndex(0, -1, 'ArrowDown'), null)
  })
})

function Menu(props: { onClose?(): void; selected?: string }): JSX.Element {
  const menuRef = useRef<HTMLDivElement>(null)
  const navigation = useMenuNavigation(menuRef, true, {
    focusOnOpen: true,
    onClose: props.onClose
  })
  return (
    <div ref={menuRef} role="menu" aria-label="Sample" onKeyDown={navigation.onKeyDown}>
      <button type="button" role="menuitem" aria-checked={props.selected === 'a' || undefined}>
        Alpha
      </button>
      <button type="button" role="menuitem" disabled>
        Broken
      </button>
      <button type="button" role="menuitem" aria-checked={props.selected === 'c' || undefined}>
        Gamma
      </button>
    </div>
  )
}

describe('useMenuNavigation', () => {
  it('focuses the first item on open and roves over enabled items only', () => {
    render(<Menu />)
    const alpha = screen.getByRole('menuitem', { name: 'Alpha' })
    const gamma = screen.getByRole('menuitem', { name: 'Gamma' })
    expect(alpha).toHaveFocus()
    fireEvent.keyDown(alpha, { key: 'ArrowDown' })
    expect(gamma).toHaveFocus()
    fireEvent.keyDown(gamma, { key: 'End' })
    expect(gamma).toHaveFocus()
    fireEvent.keyDown(gamma, { key: 'Home' })
    expect(alpha).toHaveFocus()
  })

  it('opens onto the selected item when the widget marks one', () => {
    render(<Menu selected="c" />)
    expect(screen.getByRole('menuitem', { name: 'Gamma' })).toHaveFocus()
  })

  it('closes on Escape when the widget is a popup', () => {
    const onClose = vi.fn()
    render(<Menu onClose={onClose} />)
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    expect(onClose).toHaveBeenCalledOnce()
  })
})

function Popup(): JSX.Element {
  const [open, setOpen] = useState(true)
  const menuRef = useRef<HTMLDivElement>(null)
  useOutsidePointerClose([menuRef], open, () => setOpen(false))
  return (
    <div>
      <button type="button">Elsewhere</button>
      {open && (
        <div ref={menuRef} role="menu" aria-label="Popup">
          <button type="button" role="menuitem">
            Inside
          </button>
        </div>
      )}
    </div>
  )
}

describe('useOutsidePointerClose', () => {
  it('closes on a pointer outside the popup and stays open for one inside', () => {
    render(<Popup />)
    fireEvent.pointerDown(screen.getByRole('menuitem', { name: 'Inside' }))
    expect(screen.getByRole('menu')).toBeInTheDocument()
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Elsewhere' }))
    expect(screen.queryByRole('menu')).toBeNull()
  })
})

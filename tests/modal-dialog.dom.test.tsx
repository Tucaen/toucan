import { fireEvent, render, screen } from '@testing-library/react'
import { useRef, useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { ModalDialog } from '../src/renderer/src/ModalDialog'

/**
 * The one modal policy (#231): focus moves in on open, Tab cycles inside, Escape closes, and
 * closing hands focus back to the opener. Every dialog family adopts the shell, so the contract
 * is asserted here once and each family's own test only has to show it opened through it.
 */

function Harness(props: { initial?: boolean; gated?: boolean; autoFocusField?: boolean }): JSX.Element {
  const [open, setOpen] = useState(props.initial ?? false)
  const cancel = useRef<HTMLButtonElement>(null)
  return (
    <div>
      <button type="button" onClick={() => setOpen(true)}>
        Open
      </button>
      {open && (
        <ModalDialog
          labelledBy="harness-title"
          onClose={props.gated ? undefined : () => setOpen(false)}
          initialFocus={props.autoFocusField ? undefined : cancel}
        >
          <div className="dialog">
            <strong id="harness-title">Harness</strong>
            {props.autoFocusField && <input autoFocus aria-label="Name" />}
            <button type="button" ref={cancel} onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button type="button">Confirm</button>
          </div>
        </ModalDialog>
      )}
    </div>
  )
}

describe('ModalDialog', () => {
  it('moves focus to the initial control on open and back to the opener on close', () => {
    render(<Harness />)
    const opener = screen.getByRole('button', { name: 'Open' })
    opener.focus()
    fireEvent.click(opener)
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus()
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(opener).toHaveFocus()
  })

  it('respects a control that claimed focus itself (autoFocus) instead of overriding it', () => {
    render(<Harness initial autoFocusField />)
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveFocus()
  })

  it('falls back to the first focusable control when no initial focus is named', () => {
    render(
      <ModalDialog labelledBy="t">
        <strong id="t">Plain</strong>
        <button type="button">First</button>
        <button type="button">Second</button>
      </ModalDialog>
    )
    expect(screen.getByRole('button', { name: 'First' })).toHaveFocus()
  })

  it('traps Tab at both ends of the dialog', () => {
    render(<Harness initial />)
    const dialog = screen.getByRole('dialog')
    const cancel = screen.getByRole('button', { name: 'Cancel' })
    const confirm = screen.getByRole('button', { name: 'Confirm' })
    confirm.focus()
    fireEvent.keyDown(dialog, { key: 'Tab' })
    expect(cancel).toHaveFocus()
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true })
    expect(confirm).toHaveFocus()
  })

  it('keeps Escape inert while no onClose is offered (a pending mutation)', () => {
    render(<Harness initial gated />)
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('does not let keys inside the dialog reach the surface underneath', () => {
    const outside = vi.fn()
    render(
      <div onKeyDown={outside}>
        <ModalDialog labelledBy="t2">
          <strong id="t2">Quiet</strong>
          <button type="button">Only</button>
        </ModalDialog>
      </div>
    )
    fireEvent.keyDown(screen.getByRole('button', { name: 'Only' }), { key: 'a' })
    expect(outside).not.toHaveBeenCalled()
  })
})

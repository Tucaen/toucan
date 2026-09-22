import { useId, useRef } from 'react'
import type { TicketCard } from '../../shared/ticket-source'
import { ticketCardKey } from '../../shared/ticket-source'
import { ModalDialog } from './ModalDialog'

/**
 * The confirmation a deletion always goes through - one card from the board, or everything the Done
 * column has folded away. It exists because deleting a ticket is the one board action nothing
 * undoes inside Toucan, so what is about to go is named in full: every slug, and what the source
 * says the loss costs.
 *
 * The wording about recovery is the source's, not the dialog's: whether history keeps a file is
 * something only the source that owns it can know, and the dialog must never invent the reassuring
 * half of that sentence.
 */

/** True whatever the source: nothing in Toucan puts a deleted ticket back. */
const UNDOABLE = 'Deleting cannot be undone from Toucan.'

export interface TicketDeleteDialogProps {
  cards: readonly TicketCard[]
  /** What deleting these costs, in their sources' words. Empty when no source had anything to say. */
  notes: readonly string[]
  pending: boolean
  error?: string
  onConfirm(): void
  onCancel(): void
}

export default function TicketDeleteDialog(props: TicketDeleteDialogProps): JSX.Element {
  const { cards } = props
  const titleId = useId()
  // Cancel takes the focus, not Delete: the safe action is the one an accidental Enter should hit.
  const cancel = useRef<HTMLButtonElement>(null)

  const single = cards.length === 1 ? cards[0] : undefined

  return (
    <ModalDialog
      role="alertdialog"
      labelledBy={titleId}
      initialFocus={cancel}
      onClose={props.pending ? undefined : props.onCancel}
    >
      <form
        className="dialog dialog-compact ticket-delete-dialog"
        onSubmit={(event) => {
          event.preventDefault()
          if (!props.pending) props.onConfirm()
        }}
      >
        <strong id={titleId}>{single ? `Delete “${single.title}”?` : `Delete ${cards.length} done tickets?`}</strong>
        {/* A source that cannot say what a deletion costs leaves the dialog with nothing about it,
            and a confirmation with no consequence in it is not one - so it falls back to the part
            that is true of every source rather than to silence. */}
        {(props.notes.length > 0 ? props.notes : [UNDOABLE]).map((note) => (
          <p key={note}>{note}</p>
        ))}
        {/* Named in full rather than counted: a bulk delete the user cannot read is not a
            confirmation, and the cutoff that chose these cards is not visible on a collapsed column. */}
        {!single && (
          <ul className="ticket-delete-list">
            {cards.map((card) => (
              <li key={ticketCardKey(card)}>
                <code>{card.id}</code>
                <span>{card.title}</span>
              </li>
            ))}
          </ul>
        )}
        {props.error && (
          <p className="dialog-error" role="alert">
            {props.error}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" ref={cancel} onClick={props.onCancel} disabled={props.pending}>
            Cancel
          </button>
          <button type="submit" className="primary ticket-delete-confirm" disabled={props.pending}>
            {props.pending ? 'Deleting…' : props.error ? 'Retry' : 'Delete'}
          </button>
        </div>
      </form>
    </ModalDialog>
  )
}

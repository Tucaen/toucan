import { useId, useRef } from 'react'
import { ModalDialog } from './ModalDialog'
import type { PendingMultiClose } from './multi-close-confirmation'

/**
 * Asked before one action closes several nodes at once - for instance a file node and the chat it
 * was opened from. Cancel holds the focus, so an accidental Enter closes nothing.
 */
export default function MultiCloseDialog(props: {
  pending: PendingMultiClose
  onConfirm(): void
  onCancel(): void
}): JSX.Element {
  const { labels } = props.pending
  const titleId = useId()
  const cancel = useRef<HTMLButtonElement>(null)
  return (
    <ModalDialog role="alertdialog" labelledBy={titleId} initialFocus={cancel} onClose={props.onCancel}>
      <form
        className="dialog dialog-compact"
        onSubmit={(event) => {
          event.preventDefault()
          props.onConfirm()
        }}
      >
        <strong id={titleId}>Close {labels.length} nodes?</strong>
        <p>This closes all of these nodes at once:</p>
        <ul className="multi-close-list">
          {labels.map((label, index) => (
            <li key={index}>{label}</li>
          ))}
        </ul>
        <div className="dialog-actions">
          <button type="button" ref={cancel} onClick={props.onCancel}>
            Cancel
          </button>
          <button type="submit" className="primary">
            Close {labels.length} nodes
          </button>
        </div>
      </form>
    </ModalDialog>
  )
}

import { useId, useRef } from 'react'
import { ModalDialog } from './ModalDialog'
import type { PendingMultiClose } from './multi-close-confirmation'

/**
 * Asked before one action closes several nodes at once - for instance a file node and the chat it
 * was opened from - or closes an orchestrator whose ticket worktrees would be left behind. Cancel
 * holds the focus, so an accidental Enter closes nothing.
 */
export default function MultiCloseDialog(props: {
  pending: PendingMultiClose
  onConfirm(): void
  onCancel(): void
}): JSX.Element {
  const { labels, orphanedWorktrees } = props.pending
  const titleId = useId()
  const cancel = useRef<HTMLButtonElement>(null)
  const several = labels.length > 1
  const closeLabel = several ? `Close ${labels.length} nodes` : `Close ${labels[0] ?? 'node'}`
  return (
    <ModalDialog role="alertdialog" labelledBy={titleId} initialFocus={cancel} onClose={props.onCancel}>
      <form
        className="dialog dialog-compact"
        onSubmit={(event) => {
          event.preventDefault()
          props.onConfirm()
        }}
      >
        <strong id={titleId}>{closeLabel}?</strong>
        {several && (
          <>
            <p>This closes all of these nodes at once:</p>
            <ul className="multi-close-list">
              {labels.map((label, index) => (
                <li key={index}>{label}</li>
              ))}
            </ul>
          </>
        )}
        {orphanedWorktrees.length > 0 && (
          <>
            <p>
              {orphanedWorktrees.length === 1
                ? 'This worktree still holds a ticket session of the orchestrator. It stays behind with no orchestrator to merge or clean it up:'
                : `These ${orphanedWorktrees.length} worktrees still hold ticket sessions of the orchestrator. They stay behind with no orchestrator to merge or clean them up:`}
            </p>
            <ul className="multi-close-list">
              {orphanedWorktrees.map((branch, index) => (
                <li key={index}>{branch}</li>
              ))}
            </ul>
          </>
        )}
        <div className="dialog-actions">
          <button type="button" ref={cancel} onClick={props.onCancel}>
            Cancel
          </button>
          <button type="submit" className="primary">
            {closeLabel}
          </button>
        </div>
      </form>
    </ModalDialog>
  )
}

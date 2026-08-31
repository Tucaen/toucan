import type { BrainDumpCaptureConversation, BrainDumpCaptureState } from '../../shared/brain-dump'

/**
 * A background capture's presentation lives here rather than inside the review tray, because the
 * job outlives the tray: closing the tray must not cancel it, and Cancel and the failure recovery
 * have to stay reachable afterwards. The panel renders this strip for as long as a job is running
 * or has failed unacknowledged, so the only way to lose sight of a capture is to resolve it.
 */

export interface BrainDumpCaptureStatusProps {
  capture: BrainDumpCaptureState
  onCancel(): void
  onRetry(): void
  onEditDraft(): void
  onDismiss(): void
  onOpenSessionOnCanvas(conversation: BrainDumpCaptureConversation): void
}

export default function BrainDumpCaptureStatus(props: BrainDumpCaptureStatusProps): JSX.Element | null {
  const { capture } = props
  if (capture.status === 'working') {
    return (
      <div className="brain-dump-capture-progress" role="status">
        <span className="brain-dump-capture-spinner" aria-hidden="true" />
        <span>Organizing brain dump…</span>
        <button type="button" onClick={props.onCancel}>
          Cancel
        </button>
      </div>
    )
  }
  if (capture.status !== 'failed') return null
  return (
    <div className="brain-dump-capture-failure" role="alert">
      <strong>The brain-dump skill did not finish.</strong>
      <span className="brain-dump-capture-failure-code">{capture.code}</span>
      <p>{capture.message}</p>
      {capture.code === 'auth' && <p>Open the session on the canvas to sign in with your provider.</p>}
      <div className="brain-dump-capture-actions">
        <button type="button" onClick={props.onDismiss}>
          Dismiss
        </button>
        <button type="button" onClick={props.onEditDraft}>
          Edit draft
        </button>
        <button type="button" onClick={props.onRetry}>
          Retry
        </button>
        {capture.conversation && (
          <button type="button" className="primary" onClick={() => props.onOpenSessionOnCanvas(capture.conversation!)}>
            Open session on canvas
          </button>
        )}
      </div>
    </div>
  )
}

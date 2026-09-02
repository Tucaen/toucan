import { useEffect, useRef } from 'react'
import type { BrainDumpCaptureApproval } from '../../shared/brain-dump'

export interface BrainDumpPermissionDialogProps {
  approval: BrainDumpCaptureApproval
  onResolve(optionId?: string): void
}

/** Keeps an out-of-workspace archive write visible and actionable while the capture turn waits. */
export default function BrainDumpPermissionDialog(props: BrainDumpPermissionDialogProps): JSX.Element {
  const firstOption = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    firstOption.current?.focus()
  }, [props.approval.id])

  return (
    <div
      className="brain-dump-dialog-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="brain-dump-permission-title"
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return
        event.stopPropagation()
        props.onResolve()
      }}
    >
      <section className="brain-dump-dialog brain-dump-permission-dialog">
        <strong id="brain-dump-permission-title">Permission required</strong>
        <p>Toucan needs permission to update your brain-dump library.</p>
        <code>{props.approval.title}</code>
        <div className="brain-dump-dialog-actions">
          <button type="button" onClick={() => props.onResolve()}>
            Cancel
          </button>
          {props.approval.options.map((option, index) => (
            <button
              ref={index === 0 ? firstOption : undefined}
              type="button"
              className={option.kind.startsWith('allow') ? 'primary' : undefined}
              data-kind={option.kind}
              key={option.id}
              onClick={() => props.onResolve(option.id)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </section>
    </div>
  )
}

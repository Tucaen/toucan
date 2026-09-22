import { useEffect, useRef } from 'react'
import type { BrainDumpCaptureApproval } from '../../shared/brain-dump'
import { ModalDialog } from './ModalDialog'

export interface BrainDumpPermissionDialogProps {
  approval: BrainDumpCaptureApproval
  onResolve(optionId?: string): void
}

/** Keeps an out-of-workspace archive write visible and actionable while the capture turn waits. */
export default function BrainDumpPermissionDialog(props: BrainDumpPermissionDialogProps): JSX.Element {
  const firstOption = useRef<HTMLButtonElement>(null)

  // The dialog stays mounted while one approval replaces another, so the shell's focus-on-open
  // is not enough: each new approval moves focus back to its own first option.
  useEffect(() => {
    firstOption.current?.focus()
  }, [props.approval.id])

  return (
    <ModalDialog labelledBy="brain-dump-permission-title" initialFocus={firstOption} onClose={() => props.onResolve()}>
      <section className="dialog dialog-compact brain-dump-permission-dialog">
        <strong id="brain-dump-permission-title">Permission required</strong>
        <p>Toucan needs permission to update your brain-dump library.</p>
        <code>{props.approval.title}</code>
        <div className="dialog-actions">
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
    </ModalDialog>
  )
}

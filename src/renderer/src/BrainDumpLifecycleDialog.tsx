import { useEffect, useRef, useState } from 'react'
import { BRAIN_DUMP_OUTCOME_LABELS, BRAIN_DUMP_OUTCOMES, type BrainDumpOutcome } from '../../shared/brain-dump'

/**
 * Archiving asks for one thing the library cannot infer: why the topic is done. The dialog keeps
 * the outcome mandatory, states that archiving hides nothing permanently, and on failure holds
 * both the topic and the chosen outcome so Retry is a real retry rather than a re-entry.
 */

export interface BrainDumpLifecycleDialogProps {
  title: string
  pending: boolean
  error?: string
  onArchive(outcome: BrainDumpOutcome): void
  onCancel(): void
}

export default function BrainDumpLifecycleDialog(props: BrainDumpLifecycleDialogProps): JSX.Element {
  const [outcome, setOutcome] = useState<BrainDumpOutcome>('implemented')
  const firstOption = useRef<HTMLInputElement>(null)

  useEffect(() => {
    firstOption.current?.focus()
  }, [])

  return (
    <div
      className="brain-dump-dialog-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="brain-dump-archive-title"
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return
        event.stopPropagation()
        if (!props.pending) props.onCancel()
      }}
    >
      <form
        className="brain-dump-dialog"
        onSubmit={(event) => {
          event.preventDefault()
          if (!props.pending) props.onArchive(outcome)
        }}
      >
        <strong id="brain-dump-archive-title">Archive “{props.title}”</strong>
        <p>Archived topics stay readable and searchable under the Archived collection.</p>
        <fieldset className="brain-dump-outcomes" disabled={props.pending}>
          <legend>Outcome</legend>
          {BRAIN_DUMP_OUTCOMES.map((candidate, index) => (
            <label key={candidate}>
              <input
                ref={index === 0 ? firstOption : undefined}
                type="radio"
                name="brain-dump-outcome"
                value={candidate}
                checked={outcome === candidate}
                onChange={() => setOutcome(candidate)}
              />
              <span>{BRAIN_DUMP_OUTCOME_LABELS[candidate]}</span>
            </label>
          ))}
        </fieldset>
        {props.error && (
          <p className="brain-dump-dialog-error" role="alert">
            {props.error}
          </p>
        )}
        <div className="brain-dump-dialog-actions">
          <button type="button" onClick={props.onCancel} disabled={props.pending}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={props.pending}>
            {props.pending ? 'Archiving…' : props.error ? 'Retry' : 'Archive'}
          </button>
        </div>
      </form>
    </div>
  )
}

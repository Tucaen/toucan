import { useRef, useState } from 'react'
import { BRAIN_DUMP_OUTCOME_LABELS, BRAIN_DUMP_OUTCOMES, type BrainDumpOutcome } from '../../shared/brain-dump'
import { ModalDialog } from './ModalDialog'

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

  return (
    <ModalDialog
      labelledBy="brain-dump-archive-title"
      initialFocus={firstOption}
      onClose={props.pending ? undefined : props.onCancel}
    >
      <form
        className="dialog dialog-compact"
        onSubmit={(event) => {
          event.preventDefault()
          if (!props.pending) props.onArchive(outcome)
        }}
      >
        <strong id="brain-dump-archive-title">Archive “{props.title}”</strong>
        <p>
          Archived topics stay readable and searchable under the Archived collection. They remain immutable snapshots;
          later work belongs in a linked active follow-up.
        </p>
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
          <p className="dialog-error" role="alert">
            {props.error}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" onClick={props.onCancel} disabled={props.pending}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={props.pending}>
            {props.pending ? 'Archiving…' : props.error ? 'Retry' : 'Archive'}
          </button>
        </div>
      </form>
    </ModalDialog>
  )
}

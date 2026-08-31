import { useState } from 'react'
import { promptSummary, type QueuedPrompt } from './prompt-outbox'

export interface ComposerQueueProps {
  queued: QueuedPrompt[]
  /** True while the session can no longer take a message, so waiting prompts say so. */
  stranded: boolean
  editQueued(id: string, text: string): void
  withdrawQueued(id: string): void
  sendQueuedNow(id: string): void
}

/**
 * One follow-up the captain has written but the agent has not been given yet. It is still
 * entirely local, which is exactly why it can still be rewritten or taken back - see
 * prompt-outbox.ts for why the queue is held here rather than in the adapter.
 */
function QueuedPromptChip(props: {
  entry: QueuedPrompt
  edit(text: string): void
  withdraw(): void
  sendNow(): void
}): JSX.Element {
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(props.entry.text)

  const stopEditing = (): void => {
    setText(props.entry.text)
    setEditing(false)
  }

  if (editing) {
    return (
      <li className="queued-prompt" data-editing="true">
        <textarea
          autoFocus
          aria-label="Edit queued message"
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault()
              stopEditing()
            }
          }}
        />
        <div className="queued-prompt-actions">
          <button
            type="button"
            onClick={() => {
              props.edit(text)
              setEditing(false)
            }}
          >
            Save
          </button>
          <button type="button" onClick={stopEditing}>
            Cancel
          </button>
        </div>
      </li>
    )
  }

  const summary = promptSummary(props.entry.text, props.entry.images)
  return (
    <li className="queued-prompt">
      <span className="queued-prompt-text" title={summary}>
        {summary}
      </span>
      <div className="queued-prompt-actions">
        <button type="button" title="Give this message to the running turn now" onClick={props.sendNow}>
          Send now
        </button>
        <button type="button" title="Edit before it is sent" onClick={() => setEditing(true)}>
          Edit
        </button>
        <button
          type="button"
          className="queued-prompt-withdraw"
          title="Take this message back"
          onClick={props.withdraw}
        >
          Withdraw
        </button>
      </div>
    </li>
  )
}

/** The composer's outbox: everything written but not yet handed to the agent. */
export default function ComposerQueue(props: ComposerQueueProps): JSX.Element | null {
  if (props.queued.length === 0) return null
  return (
    <div className="composer-queue" data-stranded={props.stranded || undefined}>
      <small>
        {props.stranded
          ? `This session can no longer take messages. ${props.queued.length} waiting message${props.queued.length === 1 ? '' : 's'} will not be sent.`
          : `${props.queued.length} message${props.queued.length === 1 ? '' : 's'} waiting for the agent to finish`}
      </small>
      <ul aria-label="Queued messages">
        {props.queued.map((entry) => (
          <QueuedPromptChip
            key={entry.id}
            entry={entry}
            edit={(text) => props.editQueued(entry.id, text)}
            withdraw={() => props.withdrawQueued(entry.id)}
            sendNow={() => props.sendQueuedNow(entry.id)}
          />
        ))}
      </ul>
    </div>
  )
}

import { useEffect, useId, useRef, useState } from 'react'
import { CalendarClock } from 'lucide-react'
import {
  localDateTimeInputValue,
  parseLocalDateTimeInput,
  type ScheduledMessage,
  type ScheduleResult
} from '../../shared/scheduled-message'
import { ImageAttachments } from './ImageAttachments'

/** What the composer needs to schedule messages and show the ones waiting; ChatNode supplies it. */
export interface ComposerScheduleProps {
  messages: readonly ScheduledMessage[]
  /** Schedules `prompt` plus the composer's attachments; the composer clears the text on success. */
  schedule(prompt: string, deliverAt: number): ScheduleResult
  edit(id: string, change: { text: string; deliverAt: number }): ScheduleResult
  cancel(id: string): void
  sendNow(id: string): void
  hold(id: string, held: boolean): void
}

const HOUR_MS = 60 * 60 * 1000

/** Where the popover's field starts: an hour out, to the minute - a starting point, not a preset. */
function suggestedTime(): string {
  return localDateTimeInputValue(Date.now() + HOUR_MS)
}

function formatScheduledTime(time: number): string {
  return new Date(time).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

/**
 * The clock beside dictate and send. It opens a small dialog for one local date and time; the
 * composer decides what is captured, so this only ever reports the time chosen and shows why a
 * time was refused.
 */
export function ScheduleMessageControl(props: {
  disabled: boolean
  /** Returns the reason a time was refused, or null once the message is scheduled. */
  onSchedule(deliverAt: number): string | null
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const [value, setValue] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const dialogId = useId()
  const titleId = useId()
  const inputId = useId()
  const problemId = useId()

  const close = (returnFocus: boolean): void => {
    setOpen(false)
    if (returnFocus) triggerRef.current?.focus()
  }

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent): void => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [open])

  const confirm = (): void => {
    const refused = props.onSchedule(parseLocalDateTimeInput(value))
    setProblem(refused)
    if (!refused) close(true)
  }

  return (
    <div className="composer-schedule" ref={containerRef}>
      <button
        ref={triggerRef}
        type="button"
        className="composer-schedule-button"
        aria-label="Schedule message"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? dialogId : undefined}
        title="Send this message later"
        disabled={props.disabled}
        onClick={() => {
          if (open) {
            close(false)
            return
          }
          setValue(suggestedTime())
          setProblem(null)
          setOpen(true)
        }}
      >
        <CalendarClock aria-hidden="true" />
      </button>
      {open && (
        <div
          id={dialogId}
          role="dialog"
          aria-labelledby={titleId}
          className="composer-schedule-popover nodrag nopan"
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return
            event.preventDefault()
            event.stopPropagation()
            close(true)
          }}
        >
          <strong id={titleId}>Schedule message</strong>
          <label htmlFor={inputId}>Deliver at</label>
          <input
            id={inputId}
            type="datetime-local"
            autoFocus
            value={value}
            min={localDateTimeInputValue(Date.now())}
            aria-invalid={problem ? true : undefined}
            aria-describedby={problem ? problemId : undefined}
            onChange={(event) => {
              setValue(event.target.value)
              setProblem(null)
            }}
            onKeyDown={(event) => {
              // The dialog sits inside the composer's form, so Enter must not submit the message.
              if (event.key !== 'Enter') return
              event.preventDefault()
              confirm()
            }}
          />
          {problem && (
            <small id={problemId} className="composer-schedule-problem" role="alert">
              {problem}
            </small>
          )}
          <div className="composer-schedule-actions">
            <button type="button" className="composer-schedule-confirm" onClick={confirm}>
              Schedule
            </button>
            <button type="button" onClick={() => close(true)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function ScheduledMessageItem(props: {
  entry: ScheduledMessage
  canSendNow: boolean
  edit(change: { text: string; deliverAt: number }): ScheduleResult
  cancel(): void
  sendNow(): void
  hold(held: boolean): void
}): JSX.Element {
  const { entry, hold } = props
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(entry.text)
  const [time, setTime] = useState(localDateTimeInputValue(entry.deliverAt))
  const [problem, setProblem] = useState<string | null>(null)
  const timeId = useId()
  const problemId = useId()

  // An open editor holds the message back from delivery; leaving the list must release it too.
  useEffect(() => {
    if (!editing) return
    hold(true)
    return () => hold(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing])

  const startEditing = (): void => {
    setText(entry.text)
    setTime(localDateTimeInputValue(entry.deliverAt))
    setProblem(null)
    setEditing(true)
  }
  const save = (): void => {
    // Unchanged in the field means unchanged in fact: the field only has minutes, and an overdue
    // message keeps the exact time it missed.
    const deliverAt =
      time === localDateTimeInputValue(entry.deliverAt) ? entry.deliverAt : parseLocalDateTimeInput(time)
    const result = props.edit({ text, deliverAt })
    if (result.ok) setEditing(false)
    else setProblem(result.problem)
  }

  const when = formatScheduledTime(entry.deliverAt)
  if (editing) {
    return (
      <li className="scheduled-message" data-editing="true">
        <textarea
          autoFocus
          aria-label="Edit scheduled message"
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault()
              setEditing(false)
            }
          }}
        />
        <label htmlFor={timeId}>Deliver at</label>
        <input
          id={timeId}
          type="datetime-local"
          value={time}
          aria-invalid={problem ? true : undefined}
          aria-describedby={problem ? problemId : undefined}
          onChange={(event) => {
            setTime(event.target.value)
            setProblem(null)
          }}
        />
        {problem && (
          <small id={problemId} className="composer-schedule-problem" role="alert">
            {problem}
          </small>
        )}
        <div className="scheduled-message-actions">
          <button type="button" onClick={save}>
            Save
          </button>
          <button type="button" onClick={() => setEditing(false)}>
            Cancel
          </button>
        </div>
      </li>
    )
  }

  return (
    <li className="scheduled-message" data-overdue={entry.overdue || undefined}>
      <time className="scheduled-message-time" dateTime={new Date(entry.deliverAt).toISOString()}>
        {entry.overdue ? `Overdue - was due ${when}` : `Scheduled for ${when}`}
      </time>
      {entry.text && (
        <span className="scheduled-message-text" title={entry.text}>
          {entry.text}
        </span>
      )}
      <ImageAttachments images={entry.images} />
      <div className="scheduled-message-actions">
        <button
          type="button"
          title={props.canSendNow ? 'Send this message now' : 'This session cannot take a message right now'}
          disabled={!props.canSendNow}
          onClick={props.sendNow}
        >
          Send now
        </button>
        <button type="button" title="Change the message or its time" onClick={startEditing}>
          Edit
        </button>
        <button
          type="button"
          className="scheduled-message-cancel"
          aria-label="Cancel scheduled message"
          title="Cancel this scheduled message"
          onClick={props.cancel}
        >
          Cancel
        </button>
      </div>
    </li>
  )
}

/** The messages waiting above the composer, each with its local delivery time. */
export function ScheduledMessageList(props: {
  schedule: ComposerScheduleProps
  canSendNow: boolean
}): JSX.Element | null {
  const { messages } = props.schedule
  if (messages.length === 0) return null
  const overdue = messages.filter((entry) => entry.overdue).length
  return (
    <div className="composer-scheduled" data-overdue={overdue > 0 || undefined}>
      <small>
        {overdue > 0
          ? `${overdue} scheduled message${overdue === 1 ? '' : 's'} came due while Toucan was not running and will only be sent when you choose Send now.`
          : `${messages.length} scheduled message${messages.length === 1 ? '' : 's'}`}
      </small>
      <ul aria-label="Scheduled messages">
        {messages.map((entry) => (
          <ScheduledMessageItem
            key={entry.id}
            entry={entry}
            canSendNow={props.canSendNow}
            edit={(change) => props.schedule.edit(entry.id, change)}
            cancel={() => props.schedule.cancel(entry.id)}
            sendNow={() => props.schedule.sendNow(entry.id)}
            hold={(held) => props.schedule.hold(entry.id, held)}
          />
        ))}
      </ul>
    </div>
  )
}

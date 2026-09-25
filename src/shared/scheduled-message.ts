/**
 * A composer message the captain has written and set aside for a later local time (issue #21).
 * Unlike a queued follow-up it outlives a restart, so it lives on the node like the draft does -
 * attachments included, which is why their bytes ride the workspace snapshot for as long as the
 * message waits.
 *
 * The one safety rule this module exists for: a message is delivered automatically only when
 * Toucan was running at its time. Whatever came due while the node was off the canvas - Toucan
 * closed, or the node closed and reopened - is `overdue` from the moment it is restored, and only
 * an explicit Send now delivers it.
 */
import type { AgentImageAttachment } from './agent'

export interface ScheduledMessage {
  id: string
  text: string
  images: AgentImageAttachment[]
  /** Epoch milliseconds; entered and shown in the captain's local time zone. */
  deliverAt: number
  /** Its time passed while it could not be delivered; set on restore and never cleared by time alone. */
  overdue?: true
}

export type ScheduleResult = { ok: true; messages: ScheduledMessage[] } | { ok: false; problem: string }

/**
 * Why `deliverAt` cannot be newly scheduled, or null when it can.
 * @internal exported for tests
 */
export function scheduleTimeProblem(deliverAt: number, now: number): string | null {
  if (!Number.isFinite(deliverAt)) return 'Enter a date and time.'
  if (deliverAt <= now) return 'Choose a time in the future.'
  return null
}

function contentProblem(text: string, images: readonly AgentImageAttachment[]): string | null {
  return text.trim() || images.length > 0 ? null : 'There is nothing to send.'
}

function inDeliveryOrder(messages: ScheduledMessage[]): ScheduledMessage[] {
  return [...messages].sort((a, b) => a.deliverAt - b.deliverAt)
}

export function scheduleMessage(
  messages: readonly ScheduledMessage[],
  entry: ScheduledMessage,
  now: number
): ScheduleResult {
  const problem = contentProblem(entry.text, entry.images) ?? scheduleTimeProblem(entry.deliverAt, now)
  if (problem) return { ok: false, problem }
  const { overdue: _overdue, ...fresh } = entry
  return { ok: true, messages: inDeliveryOrder([...messages, { ...fresh, text: entry.text.trim() }]) }
}

/**
 * Rewrites a waiting message. A new time must be in the future like any schedule; an overdue
 * message may keep the time it already missed, so fixing a typo does not force a reschedule -
 * and keeps it overdue, because nothing about the edit made it safe to send on its own.
 */
export function editScheduledMessage(
  messages: readonly ScheduledMessage[],
  id: string,
  change: { text: string; deliverAt: number },
  now: number
): ScheduleResult {
  const current = messages.find((message) => message.id === id)
  if (!current) return { ok: false, problem: 'That message is no longer scheduled.' }
  const keepsMissedTime = current.overdue === true && change.deliverAt === current.deliverAt
  const problem =
    contentProblem(change.text, current.images) ?? (keepsMissedTime ? null : scheduleTimeProblem(change.deliverAt, now))
  if (problem) return { ok: false, problem }
  const { overdue: _overdue, ...rest } = current
  const edited: ScheduledMessage = {
    ...rest,
    text: change.text.trim(),
    deliverAt: change.deliverAt,
    ...(keepsMissedTime ? { overdue: true } : {})
  }
  return { ok: true, messages: inDeliveryOrder(messages.map((message) => (message.id === id ? edited : message))) }
}

export function cancelScheduledMessage(messages: readonly ScheduledMessage[], id: string): ScheduledMessage[] {
  return messages.filter((message) => message.id !== id)
}

/** Removes a message and hands it back in one step, so a delivery can never take one twice. */
export function takeScheduledMessage(
  messages: readonly ScheduledMessage[],
  id: string
): { entry: ScheduledMessage | null; rest: ScheduledMessage[] } {
  const entry = messages.find((message) => message.id === id) ?? null
  return { entry, rest: entry ? messages.filter((message) => message !== entry) : [...messages] }
}

/** The earliest message due at `now` that may go out on its own; `held` ones are being edited. */
export function nextDueScheduledMessage(
  messages: readonly ScheduledMessage[],
  now: number,
  held: ReadonlySet<string> = new Set()
): ScheduledMessage | null {
  const due = messages.filter((message) => !message.overdue && !held.has(message.id) && message.deliverAt <= now)
  return inDeliveryOrder(due)[0] ?? null
}

/** When the next automatic delivery falls, or null when nothing is waiting for one. */
export function nextScheduledDelivery(messages: readonly ScheduledMessage[]): number | null {
  const times = messages.filter((message) => !message.overdue).map((message) => message.deliverAt)
  return times.length > 0 ? Math.min(...times) : null
}

/**
 * Applied whenever a node comes back onto the canvas: its messages could not have been delivered
 * while it was away, so each one whose time has passed waits for an explicit Send now instead.
 */
export function markOverdueScheduledMessages(
  messages: readonly ScheduledMessage[] | undefined,
  now: number
): ScheduledMessage[] | undefined {
  if (!messages?.length) return undefined
  return messages.map((message) =>
    message.overdue || message.deliverAt > now ? message : { ...message, overdue: true }
  )
}

function isImageAttachment(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const image = value as Partial<AgentImageAttachment>
  return (
    typeof image.id === 'string' &&
    typeof image.data === 'string' &&
    typeof image.mimeType === 'string' &&
    (image.uri === undefined || typeof image.uri === 'string')
  )
}

export function isScheduledMessage(value: unknown): value is ScheduledMessage {
  if (!value || typeof value !== 'object') return false
  const message = value as Partial<ScheduledMessage>
  return (
    typeof message.id === 'string' &&
    typeof message.text === 'string' &&
    Array.isArray(message.images) &&
    message.images.every(isImageAttachment) &&
    typeof message.deliverAt === 'number' &&
    Number.isFinite(message.deliverAt) &&
    (message.overdue === undefined || message.overdue === true)
  )
}

const pad = (value: number): string => String(value).padStart(2, '0')

/** The `<input type="datetime-local">` value for a time, in the local zone, to the minute. */
export function localDateTimeInputValue(time: number): string {
  const date = new Date(time)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** Reads a `datetime-local` value as local time; anything else is `NaN`. */
export function parseLocalDateTimeInput(value: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value)
  if (!match) return Number.NaN
  const [year, month, day, hours, minutes] = match.slice(1).map(Number) as [number, number, number, number, number]
  return new Date(year, month - 1, day, hours, minutes).getTime()
}

import { useEffect, useRef, useState } from 'react'
import type { AgentImageAttachment } from '../../shared/agent'
import {
  cancelScheduledMessage,
  editScheduledMessage,
  nextDueScheduledMessage,
  nextScheduledDelivery,
  scheduleMessage,
  takeScheduledMessage,
  type ScheduledMessage,
  type ScheduleResult
} from '../../shared/scheduled-message'

/**
 * `setTimeout` treats a delay past 2^31-1 ms (about 24.8 days) as zero and fires at once, so a
 * wait is never armed for longer than this; the timer simply re-arms when it wakes early.
 */
const LONGEST_WAIT_MS = 60 * 60 * 1000

export interface ScheduledMessagesOptions {
  /** The node's list - the persisted copy, published back through `onChange`. */
  messages: readonly ScheduledMessage[]
  onChange(messages: ScheduledMessage[]): void
  /** Whether the session would take a composer submission right now (ready or working). */
  canDeliver: boolean
  /** Submits one message through the composer's own path; called at most once per message. */
  deliver(entry: ScheduledMessage): void
}

export interface ScheduledMessagesController {
  messages: readonly ScheduledMessage[]
  schedule(entry: { text: string; images: AgentImageAttachment[]; deliverAt: number }): ScheduleResult
  edit(id: string, change: { text: string; deliverAt: number }): ScheduleResult
  cancel(id: string): void
  /** Delivers one message now, overdue or not; refused while the session cannot take it. */
  sendNow(id: string): void
  /** Holds a message back from automatic delivery while the captain is editing it. */
  hold(id: string, held: boolean): void
}

/**
 * The renderer half of issue #21: keeps one timer armed for the next automatic delivery and hands
 * each due message to `deliver`, one per render - so a second message due at the same moment sees
 * the session the first one left (working, hence queued) instead of racing it into the adapter.
 * The rules themselves, overdue included, are `shared/scheduled-message.ts`'s.
 */
export function useScheduledMessages(options: ScheduledMessagesOptions): ScheduledMessagesController {
  /**
   * The authoritative copy, as with the prompt outbox's `queuedRef`: a write is visible to the
   * next write in the same tick, before the node's round trip brings it back down as props.
   */
  const latestRef = useRef<readonly ScheduledMessage[]>(options.messages)
  const receivedRef = useRef(options.messages)
  if (options.messages !== receivedRef.current) {
    receivedRef.current = options.messages
    latestRef.current = options.messages
  }
  /** Ids already handed to `deliver`, so a stale list arriving late can never send one twice. */
  const deliveredRef = useRef(new Set<string>())
  const deliverRef = useRef(options.deliver)
  deliverRef.current = options.deliver
  const onChangeRef = useRef(options.onChange)
  onChangeRef.current = options.onChange

  const [held, setHeld] = useState<ReadonlySet<string>>(() => new Set())
  const [clock, setClock] = useState(() => Date.now())

  const current = (): readonly ScheduledMessage[] =>
    latestRef.current.filter((message) => !deliveredRef.current.has(message.id))
  const publish = (next: ScheduledMessage[]): void => {
    latestRef.current = next
    onChangeRef.current(next)
  }
  const take = (id: string): void => {
    const { entry, rest } = takeScheduledMessage(current(), id)
    if (!entry) return
    deliveredRef.current.add(entry.id)
    publish(rest)
    deliverRef.current(entry)
  }

  const messages = current()
  const waiting = messages.filter((message) => !held.has(message.id))
  const nextDelivery = nextScheduledDelivery(waiting)

  useEffect(() => {
    if (nextDelivery === null) return
    const delay = Math.min(Math.max(nextDelivery - Date.now(), 0), LONGEST_WAIT_MS)
    const timer = setTimeout(() => setClock(Date.now()), delay)
    return () => clearTimeout(timer)
  }, [nextDelivery, clock])

  useEffect(() => {
    if (!options.canDeliver) return
    const due = nextDueScheduledMessage(current(), Date.now(), held)
    if (due) take(due.id)
    // `take` and `current` read refs, so the closure from any render is the one that runs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clock, messages, options.canDeliver, held])

  return {
    messages,
    schedule: (entry) => {
      const result = scheduleMessage(current(), { id: crypto.randomUUID(), ...entry }, Date.now())
      if (result.ok) publish(result.messages)
      return result
    },
    edit: (id, change) => {
      const result = editScheduledMessage(current(), id, change, Date.now())
      if (result.ok) publish(result.messages)
      return result
    },
    cancel: (id) => publish(cancelScheduledMessage(current(), id)),
    sendNow: (id) => {
      if (options.canDeliver) take(id)
    },
    hold: (id, hold) =>
      setHeld((currentHeld) => {
        const next = new Set(currentHeld)
        if (hold) next.add(id)
        else next.delete(id)
        return next
      })
  }
}

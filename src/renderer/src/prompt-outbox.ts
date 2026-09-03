import type { AgentImageAttachment } from './image-attachment-contract'

/**
 * A follow-up the captain submitted while the agent was mid-turn. It is held here, in the
 * renderer, rather than being handed straight to `promptWhenIdle`, precisely so it can still be
 * edited or withdrawn: once a prompt crosses into the adapter - injected through the steering
 * extension or parked in the main-process `PromptWakeGate` - there is no taking it back.
 */
export interface QueuedPrompt {
  id: string
  text: string
  images: AgentImageAttachment[]
}

export function enqueuePrompt(queue: readonly QueuedPrompt[], entry: QueuedPrompt): QueuedPrompt[] {
  return [...queue, entry]
}

/**
 * Rewrites a queued prompt in place. Editing a text-only prompt down to nothing withdraws it,
 * since an empty prompt has nothing to deliver; one carrying images stays, because the images
 * are still a message.
 */
export function editQueuedPrompt(queue: readonly QueuedPrompt[], id: string, text: string): QueuedPrompt[] {
  const entry = queue.find((candidate) => candidate.id === id)
  if (!entry) return queue as QueuedPrompt[]
  const trimmed = text.trim()
  if (!trimmed && entry.images.length === 0) return withdrawQueuedPrompt(queue, id)
  return queue.map((candidate) => (candidate.id === id ? { ...candidate, text: trimmed } : candidate))
}

export function withdrawQueuedPrompt(queue: readonly QueuedPrompt[], id: string): QueuedPrompt[] {
  if (!queue.some((candidate) => candidate.id === id)) return queue as QueuedPrompt[]
  return queue.filter((candidate) => candidate.id !== id)
}

/**
 * Removes a prompt from the queue and hands it back in one step, so a dispatch decision and the
 * queue it drains from can never disagree about whether that prompt is still pending.
 */
export function takeQueuedPrompt(
  queue: readonly QueuedPrompt[],
  id?: string
): { entry: QueuedPrompt | null; rest: QueuedPrompt[] } {
  const entry = (id === undefined ? queue[0] : queue.find((candidate) => candidate.id === id)) ?? null
  if (!entry) return { entry: null, rest: queue as QueuedPrompt[] }
  return { entry, rest: queue.filter((candidate) => candidate !== entry) }
}

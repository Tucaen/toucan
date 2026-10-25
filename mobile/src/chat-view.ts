import type { AgentActivity, AgentDecisionRequest, AgentPermissionOption } from '../../src/shared/agent'
import { isFinalAssistantMessage } from '../../src/shared/agent'
import { agentTranscriptEntryKey, type AgentTranscriptState } from '../../src/shared/agent-transcript'

/**
 * What the phone renders of a transcript, derived from the same reducer state every host holds.
 * Deliberately minimal: dialogue as bubbles, tool activity as one-line summaries, reasoning
 * collapsed to an indicator, and failed/cancelled turn boundaries kept visible. The *decisions* -
 * what is final versus provisional commentary, what a tool call is called, where one deliberation
 * ends - live here so they can be tested without a DOM, and so they provably match the desktop's
 * rules (`isFinalAssistantMessage` is the same gate both use).
 */

export type ChatViewItem =
  | { type: 'bubble'; key: string; role: 'user' | 'assistant'; text: string; final: boolean; streaming: boolean }
  /** A run of adjacent thought messages, collapsed to one unobtrusive indicator. */
  | { type: 'reasoning'; key: string; streaming: boolean }
  /**
   * One tool call. `id` is what a card asks the host for its body by; `preview` is the few words
   * the host sent in the body's place (null when the call produced nothing to say).
   */
  | {
      type: 'activity'
      key: string
      id: string
      label: string
      preview: string | null
      state: 'running' | 'done' | 'failed'
    }
  | { type: 'outcome'; key: string; status: 'failed' | 'cancelled'; message: string }

export function deriveChatViewItems(state: AgentTranscriptState): ChatViewItem[] {
  const items: ChatViewItem[] = []
  const messagesById = new Map(state.messages.map((message) => [`${message.role}:${message.id}`, message]))

  for (const entry of state.transcript) {
    const key = agentTranscriptEntryKey(entry)
    if (entry.type === 'activity') {
      const activity = state.activities[entry.id]
      if (!activity) continue
      items.push({
        type: 'activity',
        key,
        id: activity.id,
        label: activitySummaryLine(activity),
        preview: activity.preview ?? null,
        state: activityState(activity)
      })
      continue
    }
    if (entry.type === 'outcome') {
      const outcome = state.outcomes.find((candidate) => candidate.id === entry.id)
      if (!outcome) continue
      items.push({ type: 'outcome', key, status: outcome.status, message: outcome.message })
      continue
    }
    const message = messagesById.get(`${entry.role}:${entry.id}`)
    if (!message) continue
    if (message.role === 'thought') {
      // Adjacent deliberation collapses into the previous indicator; anything between two thoughts
      // (prose, a tool call) is what separates two deliberations - the same rule as the desktop.
      const previous = items.at(-1)
      if (previous?.type !== 'reasoning') items.push({ type: 'reasoning', key, streaming: false })
      continue
    }
    if (message.text.length === 0) continue
    items.push({
      type: 'bubble',
      key,
      role: message.role,
      text: message.text,
      final: message.role === 'user' || isFinalAssistantMessage(message),
      streaming: message.role === 'assistant' && message.complete === false
    })
  }

  // Only the trailing indicator of a working session pulses: replay re-delivers a whole
  // conversation's thoughts at once, and every one of them reading as "thinking now" would lie.
  const last = items.at(-1)
  if (last?.type === 'reasoning' && state.status === 'working') last.streaming = true
  return items
}

/**
 * Focus mode, as the desktop's chat node applies it: reasoning, tool activity and provisional
 * (progress) assistant prose are hidden; dialogue, final answers and failed/cancelled turn
 * boundaries stay. A pure filter over the derived items, so the rule is testable without a DOM.
 */
export function focusChatViewItems(items: readonly ChatViewItem[]): ChatViewItem[] {
  return items.filter((item) => {
    if (item.type === 'reasoning' || item.type === 'activity') return false
    if (item.type === 'bubble') return item.final
    return true
  })
}

/**
 * What the chat is blocked on, or null. One request at a time, and an approval outranks a question
 * set because it is what an in-flight turn is actually parked on - the same order the desktop
 * presents, so the two surfaces cannot be answering different things.
 *
 * This is the *one* reading of "something is pending": the answer card, the status pill and the
 * hidden composer all derive from it, so none of them can disagree about whether the chat is
 * stalled.
 */
export type PendingRequest =
  | { kind: 'approval'; id: string; title: string; options: AgentPermissionOption[]; activity?: AgentActivity }
  | { kind: 'decision'; id: string; request: AgentDecisionRequest }

export function pendingRequestFrom(state: AgentTranscriptState): PendingRequest | null {
  const approval = state.approval
  if (approval) {
    return {
      kind: 'approval',
      id: approval.id,
      title: approval.title,
      options: approval.options,
      ...(approval.activity ? { activity: approval.activity } : {})
    }
  }
  // The head of the queue, not all of it: the reducer keeps provider questions FIFO and the
  // desktop presents one, so a phone that presented two would be answering out of order.
  const request = state.decisionRequests[0]
  return request ? { kind: 'decision', id: request.id, request } : null
}

/** One line per tool call: what ran, against what, no diffs and no expansion in this view. */
export function activitySummaryLine(activity: AgentActivity): string {
  const title = activity.title?.replace(/`/g, '').trim()
  if (title) return title
  const name = activity.toolName ?? activity.kind ?? 'Tool call'
  const subject = shortSubject(activity)
  return subject ? `${name} ${subject}` : name
}

/**
 * What an opened card shows: the whole call as the host sent it on request, flattened to text. A
 * command's output is `terminalOutput`, everything else's text is `content`, and a file change is
 * its path and the lines it swapped. Empty means the call produced nothing a card could show, which
 * the card says instead of rendering a blank box.
 */
export function activityBodyText(activity: AgentActivity): string {
  const sections: string[] = []
  const command = shellCommand(activity)
  if (command) sections.push(`$ ${command}`)
  const output = activity.terminalOutput ?? activity.content
  if (output?.trim()) sections.push(output.trimEnd())
  for (const diff of activity.diffs ?? []) {
    const removed = diff.oldText ? diff.oldText.split('\n').map((line) => `- ${line}`) : []
    const added = diff.newText.split('\n').map((line) => `+ ${line}`)
    sections.push([diff.path, ...removed, ...added].join('\n'))
  }
  return sections.join('\n\n')
}

/** The command line of a shell call, when its arguments name one; every other tool has none. */
function shellCommand(activity: AgentActivity): string | null {
  if (activity.kind !== 'execute') return null
  const input = activity.rawInput
  if (!input || typeof input !== 'object') return null
  const command = (input as { command?: unknown }).command
  return typeof command === 'string' && command.trim() ? command.trim() : null
}

function shortSubject(activity: AgentActivity): string | null {
  const location = activity.locations?.[0]
  if (!location) return null
  const segments = location.split(/[\\/]/).filter((segment) => segment.length > 0)
  return segments.at(-1) ?? null
}

function activityState(activity: AgentActivity): 'running' | 'done' | 'failed' {
  if (activity.status === 'failed') return 'failed'
  if (activity.status === 'completed') return 'done'
  return 'running'
}

/** The chat-level working/idle/failed pill, one reading per status so two surfaces cannot drift. */
export function chatStatusSummary(state: AgentTranscriptState): {
  label: string
  tone: 'working' | 'idle' | 'attention'
} {
  // A parked turn still reports itself as working, which is true and useless: what the reader has
  // to know is that nothing moves until they answer. This outranks every other status for the same
  // reason the answer card outranks the composer.
  if (pendingRequestFrom(state)) return { label: 'Needs you', tone: 'attention' }
  switch (state.status) {
    case 'starting':
    case 'working':
      return { label: 'Working', tone: 'working' }
    case 'auth_required':
      return { label: 'Needs sign-in', tone: 'attention' }
    case 'exited':
      return { label: 'Exited', tone: 'attention' }
    default:
      return { label: 'Idle', tone: 'idle' }
  }
}

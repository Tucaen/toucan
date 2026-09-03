import type { AgentActivity } from '../../src/shared/agent'
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
  | { type: 'activity'; key: string; label: string; state: 'running' | 'done' | 'failed' }
  | { type: 'outcome'; key: string; status: 'failed' | 'cancelled'; message: string }

export function deriveChatViewItems(state: AgentTranscriptState): ChatViewItem[] {
  const items: ChatViewItem[] = []
  const messagesById = new Map(state.messages.map((message) => [`${message.role}:${message.id}`, message]))

  for (const entry of state.transcript) {
    const key = agentTranscriptEntryKey(entry)
    if (entry.type === 'activity') {
      const activity = state.activities[entry.id]
      if (!activity) continue
      items.push({ type: 'activity', key, label: activitySummaryLine(activity), state: activityState(activity) })
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

/** One line per tool call: what ran, against what, no diffs and no expansion in this view. */
export function activitySummaryLine(activity: AgentActivity): string {
  const title = activity.title?.replace(/`/g, '').trim()
  if (title) return title
  const name = activity.toolName ?? activity.kind ?? 'Tool call'
  const subject = shortSubject(activity)
  return subject ? `${name} ${subject}` : name
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

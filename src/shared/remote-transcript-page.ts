import type { AgentActivity, AgentTurnOutcome } from './agent'
import {
  agentTranscriptEntryKey,
  type AgentChatMessage,
  type AgentTranscriptEntry,
  type AgentTranscriptState
} from './agent-transcript'

/**
 * How much of a transcript a phone is sent at once (#54).
 *
 * A long chat's join snapshot carried every message and every call ever made, even slimmed. The
 * host now sends only the most recent part - the *window* - and the phone asks for older *pages*
 * as the reader scrolls up. Both are cut from the broker's whole transcript by entry order
 * (`AgentTranscriptState.transcript`, which only ever grows), so a position in it names the same
 * entry for the life of a session and an entry key names it across reconnects.
 *
 * Nothing here may touch Node, Electron or the DOM: `mobile/` imports it too.
 */

/**
 * How many transcript entries one page holds. The window holds between one and two pages, because
 * it starts on a page boundary (`transcriptWindowStart`). Measured on real Claude transcripts an
 * entry averages well under 1 KB once slim, and assistant prose is most of it.
 * @internal exported for tests
 */
export const REMOTE_CHAT_PAGE_ENTRIES = 50

/** One stretch of older transcript: its entries in order, and only what they refer to. */
export interface RemoteTranscriptPage {
  /** Where `entries[0]` sits in the host's whole transcript; 0 is the beginning of the chat. */
  start: number
  entries: AgentTranscriptEntry[]
  messages: AgentChatMessage[]
  activities: Record<string, AgentActivity>
  outcomes: AgentTurnOutcome[]
}

/**
 * Where the join window starts for a transcript of `total` entries: the last page boundary that
 * still leaves at least a page in the window. Aligned rather than "the last N" so that the window a
 * rejoin is sent usually starts exactly where the one before it did - which is what lets the pages
 * a reader already loaded survive the rejoin (see `chat-connection.ts`).
 * @internal exported for tests
 */
export function transcriptWindowStart(total: number): number {
  return Math.max(
    0,
    Math.floor((total - REMOTE_CHAT_PAGE_ENTRIES) / REMOTE_CHAT_PAGE_ENTRIES) * REMOTE_CHAT_PAGE_ENTRIES
  )
}

/**
 * A call that has not finished yet. Its next patch may arrive long after its entry left the window
 * - a subagent's wrapping call outlives every call its subagent makes - and the phone must fold that
 * patch onto the call it holds, not read an unknown id as a new entry at the end.
 */
export function openActivity(activity: AgentActivity): boolean {
  return activity.status !== 'completed' && activity.status !== 'failed'
}

/** The same for prose: an assistant message the turn end has not settled yet. */
export function openMessage(message: AgentChatMessage): boolean {
  return message.role === 'assistant' && message.complete === false
}

function messageKey(message: { role: string; id: string }): string {
  return `${message.role}:${message.id}`
}

/** What `entries` refer to, plus whatever `extra` also keeps. */
function referenced(
  state: AgentTranscriptState,
  entries: readonly AgentTranscriptEntry[],
  extra: { message(message: AgentChatMessage): boolean; activity(activity: AgentActivity): boolean }
): Pick<RemoteTranscriptPage, 'messages' | 'activities' | 'outcomes'> {
  const messageKeys = new Set<string>()
  const activityIds = new Set<string>()
  const outcomeIds = new Set<string>()
  for (const entry of entries) {
    if (entry.type === 'message') messageKeys.add(messageKey(entry))
    else if (entry.type === 'activity') activityIds.add(entry.id)
    else outcomeIds.add(entry.id)
  }
  const activities: Record<string, AgentActivity> = {}
  for (const [id, activity] of Object.entries(state.activities)) {
    if (activityIds.has(id) || extra.activity(activity)) activities[id] = activity
  }
  return {
    messages: state.messages.filter((message) => messageKeys.has(messageKey(message)) || extra.message(message)),
    activities,
    outcomes: state.outcomes.filter((outcome) => outcomeIds.has(outcome.id))
  }
}

/**
 * The part of a transcript a phone is sent on join and on every resync: the entries from
 * `transcriptWindowStart` on, the messages, calls and outcomes they refer to, and everything still
 * open wherever its entry sits (without its entry, so it takes no slot until a page brings it).
 * Session-level state - status, plan, pending requests, models, usage - rides along whole.
 *
 * A conversation shorter than two pages is the state itself, untouched.
 */
export function transcriptWindow(state: AgentTranscriptState): { state: AgentTranscriptState; start: number } {
  const start = transcriptWindowStart(state.transcript.length)
  if (start === 0) return { state, start }
  const transcript = state.transcript.slice(start)
  return {
    start,
    state: { ...state, transcript, ...referenced(state, transcript, { message: openMessage, activity: openActivity }) }
  }
}

/**
 * The page of entries right before the entry `beforeKey` names (`agentTranscriptEntryKey`), or
 * null when this transcript holds no such entry. Anchored on a key rather than a position so that a
 * request can only ever be answered with entries that really precede what the phone holds.
 */
export function transcriptPage(state: AgentTranscriptState, beforeKey: string): RemoteTranscriptPage | null {
  const end = state.transcript.findIndex((entry) => agentTranscriptEntryKey(entry) === beforeKey)
  if (end < 0) return null
  const start = Math.max(0, end - REMOTE_CHAT_PAGE_ENTRIES)
  const entries = state.transcript.slice(start, end)
  return { start, entries, ...referenced(state, entries, { message: () => false, activity: () => false }) }
}

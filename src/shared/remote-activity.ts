import type { AgentActivity, AgentEvent } from './agent'
import type { AgentTranscriptState } from './agent-transcript'

/**
 * What a phone is sent of a tool call, instead of the call.
 *
 * A transcript's weight is almost entirely tool bodies - a diff, a file read, a command's whole
 * output - and the phone shows them collapsed. The host therefore sends every activity as its
 * metadata plus a short preview (`slimActivity`) in the snapshot, the resync and the live tail
 * alike, and the full activity travels only when the reader opens a card, as an `activity` request
 * answered by an `activity_result` (`remote-chat.ts`).
 *
 * The slim copy is still an ordinary `AgentActivity`, so the phone folds it through the shared
 * reducer like every other host and a host that predates this rule - which sends bodies - is read
 * by the same code. Nothing here may touch Node, Electron or the DOM: `mobile/` imports it too.
 */

/**
 * How much of what a call produced rides along as its preview. A line, not a body.
 * @internal exported for tests
 */
export const REMOTE_ACTIVITY_PREVIEW_LIMIT = 160

/**
 * @internal exported for tests
 *
 * Titles are mostly short, but a shell call's title is its command, and a heredoc is a command. The
 * phone's one-line summary has no use for more than this; the full title comes with the body.
 */
export const REMOTE_ACTIVITY_TITLE_LIMIT = 240

/**
 * A call that touched a hundred files names a hundred paths; the summary line reads only the first.
 * @internal exported for tests
 */
export const REMOTE_ACTIVITY_LOCATION_LIMIT = 3

/** How long one path or working directory may be before it is clipped. */
const REMOTE_ACTIVITY_PATH_LIMIT = 260

function clipped(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * The few words a collapsed card may say about what the call produced. A command's output reads
 * from its end - the last lines are the verdict - and everything else from its start. Empty is
 * absent: a preview that says nothing is not worth a key on every call.
 */
function previewOf(activity: AgentActivity): string | undefined {
  const output = activity.terminalChunk ?? activity.terminalOutput
  if (output) {
    const tail = oneLine(output.slice(-REMOTE_ACTIVITY_PREVIEW_LIMIT * 2))
    if (tail)
      return tail.length <= REMOTE_ACTIVITY_PREVIEW_LIMIT
        ? tail
        : `…${tail.slice(-(REMOTE_ACTIVITY_PREVIEW_LIMIT - 1))}`
  }
  const source = activity.content ?? activity.diffs?.[0]?.newText
  if (!source) return undefined
  const head = oneLine(source.slice(0, REMOTE_ACTIVITY_PREVIEW_LIMIT * 2))
  return head ? clipped(head, REMOTE_ACTIVITY_PREVIEW_LIMIT) : undefined
}

/**
 * The metadata of one activity and a preview, with the body left behind. It is an allow-list on
 * purpose: a field added to `AgentActivity` later is withheld from the phone until someone decides
 * it is small enough to send, rather than leaking into every snapshot because nobody thought of it.
 *
 * `status` and the exit fields stay because a card's state is not part of its body; `startedAt` and
 * `endedAt` stay because they are the duration. Patch semantics hold: a key an update did not carry
 * is absent, never `undefined`-overwritten, so a slim patch cannot blank what an earlier one set.
 * @internal exported for tests
 */
export function slimActivity(activity: AgentActivity): AgentActivity {
  const preview = previewOf(activity)
  return {
    id: activity.id,
    ...(activity.title !== undefined ? { title: clipped(activity.title, REMOTE_ACTIVITY_TITLE_LIMIT) } : {}),
    ...(activity.kind !== undefined ? { kind: activity.kind } : {}),
    ...(activity.status !== undefined ? { status: activity.status } : {}),
    ...(activity.toolName !== undefined ? { toolName: activity.toolName } : {}),
    ...(activity.locations
      ? {
          locations: activity.locations
            .slice(0, REMOTE_ACTIVITY_LOCATION_LIMIT)
            .map((location) => clipped(location, REMOTE_ACTIVITY_PATH_LIMIT))
        }
      : {}),
    ...(activity.parentToolCallId !== undefined ? { parentToolCallId: activity.parentToolCallId } : {}),
    ...(activity.subagent !== undefined ? { subagent: activity.subagent } : {}),
    ...(activity.terminalCwd !== undefined
      ? { terminalCwd: clipped(activity.terminalCwd, REMOTE_ACTIVITY_PATH_LIMIT) }
      : {}),
    ...(activity.exitCode !== undefined ? { exitCode: activity.exitCode } : {}),
    ...(activity.exitSignal !== undefined ? { exitSignal: activity.exitSignal } : {}),
    ...(activity.startedAt !== undefined ? { startedAt: activity.startedAt } : {}),
    ...(activity.endedAt !== undefined ? { endedAt: activity.endedAt } : {}),
    ...(preview !== undefined ? { preview } : {})
  }
}

/**
 * One tail event as the phone receives it. Only the two events that carry an activity change; an
 * approval's `activity` is the call the agent is asking to make, which is exactly as heavy as any
 * other (a write's whole payload) and which the phone shows as one line.
 */
export function slimAgentEvent(event: AgentEvent): AgentEvent {
  if (event.type === 'activity') return { ...event, activity: slimActivity(event.activity) }
  if (event.type === 'approval' && event.activity) return { ...event, activity: slimActivity(event.activity) }
  return event
}

/** A snapshot as the phone receives it: every activity slim, nothing else touched. */
export function slimTranscriptState(state: AgentTranscriptState): AgentTranscriptState {
  const activities: AgentTranscriptState['activities'] = {}
  for (const [id, activity] of Object.entries(state.activities)) activities[id] = slimActivity(activity)
  return {
    ...state,
    activities,
    approval: state.approval?.activity
      ? { ...state.approval, activity: slimActivity(state.approval.activity) }
      : state.approval
  }
}

import type { SessionUpdate, ToolCallContent } from '@agentclientprotocol/sdk'
import type { AgentActivity, AgentFileDiff } from './agent'

type ToolCallSessionUpdate = Extract<SessionUpdate, { sessionUpdate: 'tool_call' | 'tool_call_update' }>

function toolContentText(content: ToolCallContent[] | null | undefined): string | undefined {
  if (!content?.length) return undefined
  const lines = content.flatMap((item) => {
    if (item.type === 'content' && item.content.type === 'text') return [item.content.text]
    if (item.type === 'diff') return [`Changed ${item.path}`]
    if (item.type === 'terminal') return ['Terminal output is available.']
    return []
  })
  return lines.length > 0 ? lines.join('\n') : undefined
}

function toolContentDiffs(content: ToolCallContent[] | null | undefined): AgentFileDiff[] | undefined {
  const diffs = content?.flatMap((item) => item.type === 'diff'
    ? [{ path: item.path, ...(item.oldText ? { oldText: item.oldText } : {}), newText: item.newText }]
    : [])
  return diffs?.length ? diffs : undefined
}

/**
 * The programmatic tool name. ACP's top-level `name` is still marked unstable and no adapter we
 * ship sends it; claude-agent-acp puts the name in `_meta.claudeCode.toolName` on every tool
 * notification it builds. Read both, preferring the standard field, so cards keyed on the tool
 * name work today and keep working when adapters move to `name`.
 */
function toolNameFromUpdate(update: ToolCallSessionUpdate): string | undefined {
  if (update.name) return update.name
  const claudeCode = (update._meta as { claudeCode?: { toolName?: unknown } } | null | undefined)?.claudeCode
  return typeof claudeCode?.toolName === 'string' && claudeCode.toolName ? claudeCode.toolName : undefined
}

/** Convert ACP's patch-style tool updates without inventing values that overwrite earlier details. */
export function activityFromUpdate(update: ToolCallSessionUpdate): AgentActivity {
  const content = toolContentText(update.content)
  const diffs = toolContentDiffs(update.content)
  const toolName = toolNameFromUpdate(update)
  return {
    id: update.toolCallId,
    ...(update.title ? { title: update.title } : {}),
    ...(update.kind ? { kind: update.kind } : {}),
    ...(update.status ? { status: update.status } : {}),
    ...(content ? { content } : {}),
    ...(update.locations ? { locations: update.locations.map((location) => location.path) } : {}),
    // The name and the arguments are what a per-tool card reads; ACP sends them only on the
    // updates that have them, and an update without them must not blank out what we recorded.
    ...(toolName ? { toolName } : {}),
    ...(update.rawInput !== undefined && update.rawInput !== null ? { rawInput: update.rawInput } : {}),
    ...(diffs ? { diffs } : {})
  }
}

export function activityTitle(activity: AgentActivity): string {
  if (activity.title?.trim()) return activity.title

  const location = activity.locations?.[0]
  switch (activity.kind) {
    case 'read': return location ? `Inspected ${location}` : 'Inspected project files'
    case 'edit': return location ? `Updated ${location}` : 'Updated project files'
    case 'delete': return location ? `Deleted ${location}` : 'Deleted project files'
    case 'move': return location ? `Moved ${location}` : 'Moved project files'
    case 'search': return 'Searched the project'
    case 'execute': return 'Ran a command'
    case 'think': return 'Worked through the task'
    case 'fetch': return 'Fetched external information'
    case 'switch_mode': return 'Switched working mode'
    default: return 'Performed a tool action'
  }
}

/** A tool call has stopped moving: no further output, and its duration is final. */
export function isSettledActivity(status: AgentActivity['status']): boolean {
  return status === 'completed' || status === 'failed'
}

/**
 * Folds a patch-style ACP update into the activity already on record, stamping the timing the
 * card header needs. ACP reports no timing at all, so `startedAt` is the moment this client
 * first saw the call and `endedAt` the moment it first saw it settle; a call that goes back to
 * working (a retried or resumed tool) drops its end rather than showing a frozen stale duration.
 */
export function mergeActivity(
  existing: AgentActivity | undefined,
  incoming: AgentActivity,
  now: number
): AgentActivity {
  const merged = { ...existing, ...incoming }
  const settled = isSettledActivity(merged.status)
  return {
    ...merged,
    startedAt: existing?.startedAt ?? now,
    ...(settled ? { endedAt: existing?.endedAt ?? now } : { endedAt: undefined })
  }
}

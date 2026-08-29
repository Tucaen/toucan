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

interface TerminalMeta {
  terminal_info?: { cwd?: unknown } | null
  terminal_output?: { data?: unknown } | null
  terminal_output_delta?: { data?: unknown } | null
  terminal_exit?: { exit_code?: unknown; signal?: unknown } | null
}

function terminalMetaOf(update: ToolCallSessionUpdate): TerminalMeta {
  return (update._meta ?? {}) as TerminalMeta
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * The next slice of a command's output. Both adapters carry it out-of-band in `_meta` rather than
 * in ACP content, under two keys that differ only in whether the client claimed to want whole
 * outputs (`terminal_output`) or streamed ones (`terminal_output_delta`). We claim the former and
 * still read both, because neither adapter sends a *replacement*: claude-agent-acp emits the whole
 * output exactly once per Bash call, and codex-acp emits one key per chunk as the command runs.
 * Appending is therefore correct for both, and it is what `mergeActivity` does with this value.
 */
function terminalChunkOf(update: ToolCallSessionUpdate): string | undefined {
  const meta = terminalMetaOf(update)
  const data = meta.terminal_output?.data ?? meta.terminal_output_delta?.data
  return typeof data === 'string' && data.length > 0 ? data : undefined
}

/**
 * A shell call's exit status. codex-acp reports it structurally in `rawOutput` and both adapters
 * report it as `terminal_exit`; prefer the terminal channel, which is the one that also exists for
 * claude-agent-acp.
 */
function exitStatusOf(update: ToolCallSessionUpdate): { exitCode?: number; exitSignal?: string } {
  const exit = terminalMetaOf(update).terminal_exit
  const rawOutput = update.rawOutput as { exit_code?: unknown } | null | undefined
  const exitCode = asFiniteNumber(exit?.exit_code)
    ?? asFiniteNumber(typeof rawOutput === 'object' ? rawOutput?.exit_code : undefined)
  const signal = exit?.signal
  return {
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(typeof signal === 'string' && signal ? { exitSignal: signal } : {})
  }
}

/** Convert ACP's patch-style tool updates without inventing values that overwrite earlier details. */
export function activityFromUpdate(update: ToolCallSessionUpdate): AgentActivity {
  const content = toolContentText(update.content)
  const diffs = toolContentDiffs(update.content)
  const toolName = toolNameFromUpdate(update)
  const terminalChunk = terminalChunkOf(update)
  const terminalCwd = terminalMetaOf(update).terminal_info?.cwd
  return {
    ...exitStatusOf(update),
    ...(terminalChunk ? { terminalChunk } : {}),
    ...(typeof terminalCwd === 'string' && terminalCwd ? { terminalCwd } : {}),
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
    ...(update.rawOutput !== undefined && update.rawOutput !== null ? { rawOutput: update.rawOutput } : {}),
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
 *
 * Terminal output is the one field an update *adds to* rather than replaces: each `terminalChunk`
 * is appended to what the call has produced so far (see `terminalChunkOf`), and the chunk itself
 * is dropped from the result so a re-merge of the same activity object can never double it.
 */
export function mergeActivity(
  existing: AgentActivity | undefined,
  incoming: AgentActivity,
  now: number
): AgentActivity {
  const merged = { ...existing, ...incoming }
  const settled = isSettledActivity(merged.status)
  const terminalOutput = incoming.terminalChunk
    ? `${existing?.terminalOutput ?? ''}${incoming.terminalChunk}`
    : existing?.terminalOutput
  return {
    ...merged,
    terminalChunk: undefined,
    ...(terminalOutput !== undefined ? { terminalOutput } : {}),
    startedAt: existing?.startedAt ?? now,
    ...(settled ? { endedAt: existing?.endedAt ?? now } : { endedAt: undefined })
  }
}

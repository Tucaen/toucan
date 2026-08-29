import type { AgentActivity } from '../../shared/agent'
import { mcpToolCallFor } from './mcp-tool-call'
import { asRecord, asText, normalizeToolName } from './tool-input'

/**
 * The agent loading a skill (or running a slash command, which is the same act through a
 * different tool). Opaque by default: ACP titles it "Skill" and the name of the thing actually
 * loaded is buried in the arguments, so the one fact the reader needs - *which* set of
 * instructions is now steering the turn - is the one the generic card throws away.
 */
export interface SkillInvocation {
  /** The skill or command name, without the leading slash. */
  name: string
  /** What was passed to it, when the call carried arguments. */
  args?: string
  /** Why it was loaded, when the agent said - `Skill` has no such field, `SlashCommand` may. */
  reason?: string
}

const SKILL_TOOLS = new Set(['skill', 'slashcommand'])

/** `/code-review since main` -> name `code-review`, args `since main`. */
function splitCommand(command: string): { name: string; args?: string } {
  const bare = command.replace(/^\//, '').trim()
  const space = bare.search(/\s/)
  if (space < 0) return { name: bare }
  return { name: bare.slice(0, space), args: bare.slice(space + 1).trim() || undefined }
}

/**
 * Recognizes a skill or slash-command call, excluding MCP calls for the same reason
 * `subagent-task.ts` does. Returns `null` when the call names no skill at all: a card whose whole
 * job is to say which skill ran has nothing to add over the generic one without that name.
 */
export function parseSkillInvocation(activity: AgentActivity): SkillInvocation | null {
  const name = normalizeToolName(activity.toolName)
  if (!name || !SKILL_TOOLS.has(name)) return null
  if (mcpToolCallFor(activity) !== null) return null

  const input = asRecord(activity.rawInput) ?? {}
  const named = asText(input.skill) ?? asText(input.skill_name) ?? asText(input.name) ?? asText(input.command)
  if (!named) return null
  const command = splitCommand(named)
  const args = asText(input.args) ?? asText(input.arguments) ?? command.args
  return {
    name: command.name,
    ...(args ? { args } : {}),
    ...(asText(input.reason) ? { reason: asText(input.reason) } : {})
  }
}

const parsedInvocations = new WeakMap<AgentActivity, SkillInvocation | null>()

/** `parseSkillInvocation` for the render path, cached the way `fileOperationFor` is. */
export function skillInvocationFor(activity: AgentActivity): SkillInvocation | null {
  const cached = parsedInvocations.get(activity)
  if (cached !== undefined) return cached
  const invocation = parseSkillInvocation(activity)
  parsedInvocations.set(activity, invocation)
  return invocation
}

export function skillInvocationSummary(invocation: SkillInvocation): string {
  return invocation.args ? `/${invocation.name} ${invocation.args}` : `/${invocation.name}`
}

import { createContext } from 'react'
import type { AgentActivity, AgentCommand } from '../../shared/agent'
import { mcpToolCallFor } from './mcp-tool-call'
import { asRecord, asText, memoizePerActivity, normalizeToolName } from './tool-input'

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
  return { name: command.name, ...(args ? { args } : {}) }
}

/** `parseSkillInvocation` for the render path, cached per activity object. */
export const skillInvocationFor = memoizePerActivity(parseSkillInvocation)

export function skillInvocationSummary(invocation: SkillInvocation): string {
  return invocation.args ? `/${invocation.name} ${invocation.args}` : `/${invocation.name}`
}

/**
 * Why a skill was loaded, as far as anything actually knows. Neither tool carries a reason field,
 * so the honest answer is the skill's *own* advertised description - the same text the composer's
 * slash list shows, which is what says why an agent would reach for it. Matched on the name the
 * session advertised (and its aliases, which resolve to one command), so a skill ADE never saw
 * advertised simply has no description rather than a guessed one.
 */
export function skillDescription(
  invocation: SkillInvocation,
  commands: readonly AgentCommand[]
): string | undefined {
  const name = invocation.name.toLowerCase()
  const command = commands.find((candidate) => candidate.name.replace(/^\//, '').toLowerCase() === name)
  return command?.description || undefined
}

/**
 * The slash commands and skills the session advertised, for the cards that name one. Reaches the
 * card as context for the same reason `WorkspaceRootsContext` does: it sits several components
 * below the only place that has it.
 */
export const SessionCommandsContext = createContext<readonly AgentCommand[]>([])

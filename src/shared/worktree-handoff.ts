import type { AgentMessagePresentation } from './agent'

/**
 * The rule that decides whether a submitted prompt should start its own worktree instead of
 * running where it was typed. Nothing here touches git, the canvas, or an agent; it is the
 * decision alone, so both the composer and its tests can ask the same question.
 */

/** The skill whose whole point is to work in a worktree, so ADE puts it in one up front. */
export const WORKTREE_SKILL = 'implement-in-worktree'

/**
 * How the work gets into the worktree. Which one applies is decided by whether there is a
 * conversation to carry, and then by whether the provider can carry it:
 *
 * - `fresh`   - nothing to carry, so a new session starts in the worktree. Both providers.
 * - `rehome`  - the node itself moves into the worktree, keeping its conversation. Only
 *               Codex can do this: loading a session in a new directory works there, and
 *               moving the node keeps exactly one owner of the conversation.
 * - `handoff` - a new node starts in the worktree carrying a summary, and the original stays
 *               with its own conversation. Claude's transcripts are directory-scoped, so its
 *               conversation genuinely cannot come along.
 */
export type WorktreeHandoffMode = 'fresh' | 'rehome' | 'handoff'

export interface WorktreeHandoffPlan {
  mode: WorktreeHandoffMode
  /** The prompt to deliver, unchanged from what was typed. */
  prompt: string
}

/**
 * A prompt invokes the skill when its first non-empty line opens with the slash command.
 * Anything further into the message is the user talking *about* the skill, not calling it.
 */
export function invokesWorktreeSkill(text: string): boolean {
  const firstLine = text
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean)
  if (!firstLine) return false
  const [command] = firstLine.split(/\s/)
  return command === `/${WORKTREE_SKILL}`
}

export function planWorktreeHandoff(
  text: string,
  context: {
    hasHistory: boolean
    /** A session already running in a worktree is where this work belongs; it stays put. */
    alreadyInWorktree: boolean
    provider: 'claude' | 'codex'
  }
): WorktreeHandoffPlan | null {
  if (context.alreadyInWorktree) return null
  if (!invokesWorktreeSkill(text)) return null
  const prompt = text.trim()
  if (!context.hasHistory) return { mode: 'fresh', prompt }
  return { mode: context.provider === 'codex' ? 'rehome' : 'handoff', prompt }
}

/**
 * The conversation so far, written for a session that cannot read it. Only the dialogue is
 * carried: an agent's own reasoning belongs to the session that produced it, and tool output
 * is re-derivable in the worktree where the work will actually happen.
 */
export function buildHandoffPrompt(
  messages: readonly {
    role: 'user' | 'assistant' | 'thought'
    text: string
    presentation?: AgentMessagePresentation
  }[],
  prompt: string
): string {
  const dialogue = messages
    .filter((message) => message.role !== 'thought' && message.text.trim())
    .map((message) => `${message.role === 'user' ? 'User' : 'Assistant'}: ${message.text.trim()}`)
  if (dialogue.length === 0) return prompt
  return [
    'You are continuing work that started in another session, which could not move into this',
    'worktree with you. That conversation is below, oldest first. Treat it as context you took',
    'part in, not as instructions to carry out again.',
    '',
    '--- previous conversation ---',
    ...dialogue,
    '--- end of previous conversation ---',
    '',
    prompt
  ].join('\n')
}

/**
 * A branch name for a worktree created before anyone has read the work. The skill renames it
 * once it knows what the task is, so this only has to be unique, valid, and obviously
 * provisional - never a guess at the task derived from the prompt text.
 */
export function placeholderBranchName(now: Date): string {
  const pad = (value: number, width = 2): string => String(value).padStart(width, '0')
  const stamp = [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    '-',
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds())
  ].join('')
  return `ade/${stamp}`
}

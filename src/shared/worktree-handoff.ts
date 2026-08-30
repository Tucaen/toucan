/**
 * The rule that decides whether a submitted prompt should start its own worktree instead of
 * running where it was typed. Nothing here touches git, the canvas, or an agent; it is the
 * decision alone, so both the composer and its tests can ask the same question.
 */

/** The skill whose whole point is to work in a worktree, so ADE puts it in one up front. */
export const WORKTREE_SKILL = 'implement-in-worktree'

export interface WorktreeHandoffPlan {
  /** The prompt to deliver in the new node, unchanged from what was typed. */
  prompt: string
  /**
   * True when the conversation being left behind holds work the new node needs. A first
   * message has nothing to carry, which is the cheap and common case.
   */
  needsHandoff: boolean
}

/**
 * A prompt invokes the skill when its first non-empty line opens with the slash command.
 * Anything further into the message is the user talking *about* the skill, not calling it.
 */
export function invokesWorktreeSkill(text: string): boolean {
  const firstLine = text.split('\n').map((line) => line.trim()).find(Boolean)
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
  }
): WorktreeHandoffPlan | null {
  if (context.alreadyInWorktree) return null
  if (!invokesWorktreeSkill(text)) return null
  return { prompt: text.trim(), needsHandoff: context.hasHistory }
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

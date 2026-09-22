import type { AgentCommand } from '../../shared/agent'
import { tokenOpeningWord, type CompletionToken } from './completion-token'

export type SlashCompletionQuery = CompletionToken

/**
 * A slash starts a command wherever a word starts - `tokenOpeningWord` owns that rule, shared with
 * the `@` picker so the two can never drift. Anywhere in the prompt, not just opening a line:
 * captains write `/name` mid-sentence ("refactored this, now run /code-review since main"), so a
 * menu anchored to the line start would refuse to help with exactly those. The agent CLI only
 * expands a command that *opens* the prompt, so `hoistSlashCommand` moves it there on send - the
 * affordance stays where it is typed and still fires.
 * @internal exported for tests
 */
export function slashCompletionQuery(draft: string, caret: number): SlashCompletionQuery | null {
  return tokenOpeningWord(draft, caret, '/')
}

/**
 * Narrows the agent's advertised commands to what is being typed. Prefix matches come first -
 * they are what the captain is almost always reaching for - and everything keeps the agent's own
 * ordering within its group, so the list never reshuffles for reasons the captain can't see.
 * @internal exported for tests
 */
export function filterSlashCommands(commands: AgentCommand[], query: string): AgentCommand[] {
  if (!query) return [...commands]
  const needle = query.toLowerCase()
  const ranked: Array<{ command: AgentCommand; index: number; position: number }> = []
  commands.forEach((command, index) => {
    const position = command.name.toLowerCase().indexOf(needle)
    if (position >= 0) ranked.push({ command, index, position })
  })
  ranked.sort((a, b) => {
    const aPrefix = a.position === 0 ? 0 : 1
    const bPrefix = b.position === 0 ? 0 : 1
    if (aPrefix !== bPrefix) return aPrefix - bPrefix
    return a.index - b.index
  })
  return ranked.map((entry) => entry.command)
}

export interface SlashCommandAcceptance {
  draft: string
  caret: number
}

/**
 * Replaces the slash token under the caret with the chosen command, keeping whatever already
 * followed the caret. A command that takes arguments gets a trailing space so the caret lands
 * exactly where those arguments go.
 */
export function acceptSlashCommand(
  draft: string,
  caret: number,
  query: Pick<SlashCompletionQuery, 'start'>,
  command: AgentCommand
): SlashCommandAcceptance {
  const inserted = command.input ? `/${command.name} ` : `/${command.name}`
  return {
    draft: draft.slice(0, query.start) + inserted + draft.slice(caret),
    caret: query.start + inserted.length
  }
}

/** Up/down through the filtered list, wrapping at both ends. */
export function moveSlashSelection(current: number, count: number, delta: number): number {
  if (count <= 0) return 0
  return (((current + delta) % count) + count) % count
}

/**
 * Everything the composer remembers about the completion between key presses. It is deliberately
 * *not* "is the menu open" - openness is derived from the draft each render, so a stale flag can
 * never leave the menu hanging over a draft that no longer has a slash token in it.
 */
export interface SlashCompletionState {
  /** Start index of the token Escape dismissed, so typing more of that same token stays dismissed. */
  dismissedStart: number | null
  /**
   * The token text just inserted by accepting a command. An accepted token still matches its own
   * command, so without this the menu would sit open over the choice that was just made; keying it
   * by text means editing that token again offers the list right back.
   */
  acceptedQuery: string | null
  highlight: number
}

export const emptySlashCompletion: SlashCompletionState = {
  dismissedStart: null,
  acceptedQuery: null,
  highlight: 0
}

export interface SlashCompletionView {
  /** The slash token under the caret, or null when the draft isn't offering one. */
  token: SlashCompletionQuery | null
  matches: AgentCommand[]
  open: boolean
  /** Always in range, so a highlight left over from a longer list can't point past the new one. */
  activeIndex: number
}

/** The one place that decides what the completion shows for a given draft, caret and memory. */
export function slashCompletionView(
  draft: string,
  caret: number,
  commands: AgentCommand[],
  state: SlashCompletionState
): SlashCompletionView {
  const token = slashCompletionQuery(draft, caret)
  const matches = token ? filterSlashCommands(commands, token.query) : []
  const open =
    token !== null && matches.length > 0 && state.dismissedStart !== token.start && state.acceptedQuery !== token.query
  return { token, matches, open, activeIndex: Math.min(state.highlight, Math.max(matches.length - 1, 0)) }
}

export function highlightSlashCommand(state: SlashCompletionState, highlight: number): SlashCompletionState {
  return { ...state, highlight }
}

/** Escape: hide the list for this token without touching the draft. */
export function dismissSlashCompletion(
  state: SlashCompletionState,
  token: SlashCompletionQuery | null
): SlashCompletionState {
  return { ...state, dismissedStart: token?.start ?? null }
}

/** A command was inserted: nothing is dismissed any more, but this token has been answered. */
export function acceptedSlashCompletion(state: SlashCompletionState, command: AgentCommand): SlashCompletionState {
  return { dismissedStart: null, acceptedQuery: command.name, highlight: 0 }
}

/** Word characters a command name is made of, used to strip prose punctuation off a typed token. */
const commandNameEnd = /[^A-Za-z0-9_:-]+$/

/**
 * The agent CLI expands a slash command only when the prompt's first text block *starts* with it;
 * anywhere else the literal text reaches the model, which can only reach for the `Skill` tool -
 * and the commands that most need this (`disable-model-invocation`) are exactly the ones missing
 * from that tool's registry, so a mid-draft command dead-ends in a confusing non-answer.
 *
 * So the composer keeps offering completions at every word boundary (see `slashCompletionQuery`)
 * and this moves the chosen command to the front on the way out. The rest of the command's own
 * line goes with it - accepting parks the caret right after the command, so what follows it there
 * is what was typed as its arguments - and the prose the command was lifted out of drops below.
 *
 * Only a command the captain took from the menu (`accepted`) moves. A command name the draft
 * merely mentions is prose - "what does /implement-in-worktree do?" asks about the skill rather
 * than calling it, and hoisting that would invoke it - so a mention is left exactly where it is.
 * A draft already opening with a command needs no hoist at all; it is only trimmed, so leading
 * whitespace can't push it off offset 0 where the CLI stops seeing it.
 */
export function hoistSlashCommand(draft: string, commands: AgentCommand[], accepted: string | null): string {
  const names = new Set(commands.map((command) => command.name))
  for (const word of draft.matchAll(/\S+/g)) {
    // The same rule the picker used when it offered this command: `tokenOpeningWord` reading to
    // the word's end is exactly what a caret parked there would have completed, so the hoist can
    // never fire on a `/` the menu treats as prose (`src/main`) or miss one it offered.
    const token = tokenOpeningWord(draft, word.index + word[0].length, '/')
    if (!token) continue
    const name = names.has(token.query) ? token.query : token.query.replace(commandNameEnd, '')
    if (!names.has(name)) continue
    // Already opening the draft: nothing to move, only the whitespace that would push it off
    // offset 0, where the CLI stops seeing it.
    if (draft.slice(0, token.start).trim() === '') return draft.trimStart()
    if (name !== accepted) continue
    // Everything up to the newline is the command's arguments; whatever else the draft holds -
    // the prose it was lifted out of, and any later lines - follows below it.
    const trailing = draft.slice(token.start + 1 + token.query.length)
    const lineEnd = trailing.indexOf('\n')
    const args = (lineEnd < 0 ? trailing : trailing.slice(0, lineEnd)).trim()
    const rest = `${draft.slice(0, token.start).trim()}\n${lineEnd < 0 ? '' : trailing.slice(lineEnd + 1)}`.trim()
    return [`/${name}${args ? ` ${args}` : ''}`, rest].filter(Boolean).join('\n')
  }
  return draft
}

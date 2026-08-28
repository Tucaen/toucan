import type { AgentCommand } from '../../shared/agent'

export interface SlashCompletionQuery {
  /** What has been typed after the slash, up to the caret. */
  query: string
  /** Index of the `/` in the draft, so accepting can rewrite exactly that token. */
  start: number
}

/**
 * A slash command is only a command when it opens a line - anywhere else (`src/main`, `and/or`)
 * a slash is ordinary prose, and a completion popping up there would fight the typing. The query
 * stops at the caret so the menu still narrows while the caret sits inside a half-typed name, and
 * it never spans whitespace: once a space is typed the captain is writing arguments, not choosing.
 */
export function slashCompletionQuery(draft: string, caret: number): SlashCompletionQuery | null {
  const lineStart = draft.lastIndexOf('\n', caret - 1) + 1
  const line = draft.slice(lineStart, caret)
  const match = /^(\s*)\/(\S*)$/.exec(line)
  if (!match) return null
  return { query: match[2], start: lineStart + match[1].length }
}

/**
 * Narrows the agent's advertised commands to what is being typed. Prefix matches come first -
 * they are what the captain is almost always reaching for - and everything keeps the agent's own
 * ordering within its group, so the list never reshuffles for reasons the captain can't see.
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
  return ((current + delta) % count + count) % count
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
  const open = token !== null
    && matches.length > 0
    && state.dismissedStart !== token.start
    && state.acceptedQuery !== token.query
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
export function acceptedSlashCompletion(
  state: SlashCompletionState,
  command: AgentCommand
): SlashCompletionState {
  return { dismissedStart: null, acceptedQuery: command.name, highlight: 0 }
}

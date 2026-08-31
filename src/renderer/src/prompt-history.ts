/** Prompts sent from one composer this session, walkable with the arrow keys. */
export interface PromptHistoryState {
  /** Sent prompts, oldest first. */
  entries: string[]
  /** Which entry is currently recalled into the composer; null while not walking history. */
  index: number | null
  /** Whatever was half-typed when the walk started, restored on the way back out. */
  stashedDraft: string
}

/**
 * A session's history is a convenience, not a record, so it is bounded: a long-lived node cannot
 * grow it without limit, and nobody is going to arrow past a hundred prompts anyway.
 */
export const PROMPT_HISTORY_LIMIT = 100

export const emptyPromptHistory: PromptHistoryState = { entries: [], index: null, stashedDraft: '' }

/**
 * Records a sent prompt and ends any walk in progress, so the next ArrowUp starts again from the
 * newest prompt rather than wherever the previous walk happened to stop.
 */
export function rememberPrompt(state: PromptHistoryState, text: string): PromptHistoryState {
  const trimmed = text.trim()
  if (!trimmed) return { ...state, index: null, stashedDraft: '' }
  const entries =
    state.entries.at(-1) === trimmed ? state.entries : [...state.entries, trimmed].slice(-PROMPT_HISTORY_LIMIT)
  return { entries, index: null, stashedDraft: '' }
}

/**
 * Fills an untouched history from prompts the transcript already shows - so a conversation
 * resumed from disk can be arrowed back through, rather than starting blank while its own
 * history sits visible right above the composer. Only ever seeds once: after that the history is
 * whatever this composer has sent, and re-seeding would duplicate those entries.
 */
export function seedPromptHistory(state: PromptHistoryState, sent: readonly string[]): PromptHistoryState {
  if (state.entries.length > 0) return state
  return sent.reduce(rememberPrompt, state)
}

/** Walks one prompt further back, stashing the live draft the first time. Stops at the oldest. */
export function recallPrevious(
  state: PromptHistoryState,
  currentDraft: string
): { state: PromptHistoryState; draft: string } {
  if (state.entries.length === 0) return { state, draft: currentDraft }
  if (state.index === null) {
    const index = state.entries.length - 1
    return { state: { ...state, index, stashedDraft: currentDraft }, draft: state.entries[index] }
  }
  const index = Math.max(0, state.index - 1)
  return { state: { ...state, index }, draft: state.entries[index] }
}

/** Walks one prompt forward, leaving history (and restoring the stashed draft) past the newest. */
export function recallNext(state: PromptHistoryState): { state: PromptHistoryState; draft: string } {
  if (state.index === null) return { state, draft: state.stashedDraft }
  if (state.index >= state.entries.length - 1) {
    return { state: { ...state, index: null, stashedDraft: '' }, draft: state.stashedDraft }
  }
  const index = state.index + 1
  return { state: { ...state, index }, draft: state.entries[index] }
}

/** Ends a walk in place - used when the user starts typing over a recalled prompt. */
export function leaveHistory(state: PromptHistoryState): PromptHistoryState {
  if (state.index === null) return state
  return { ...state, index: null, stashedDraft: '' }
}

/**
 * The one rule both composer pickers share: a sigil (`/` for commands, `@` for file references)
 * only starts a token when it *opens a word* - that is, at the start of the draft or after
 * whitespace. Welded to a word it is ordinary text (`src/main`, `and/or`, `morgan@example.com`,
 * `react@19`) and a menu appearing there would fight the typing.
 *
 * Deliberately whitespace and nothing else: a slash after an opening bracket or quote (`(/rev`)
 * is left alone too, because the alternative - treating every punctuation mark as a boundary -
 * turns paths and prose into token starts far more often than it helps.
 *
 * The token runs to the caret, not to the end of the word, so a caret parked inside a half-typed
 * name still narrows the list, and it never spans whitespace: once a space is typed the captain is
 * writing arguments, not choosing.
 */
export interface CompletionToken {
  /** What has been typed after the sigil, up to the caret. */
  query: string
  /** Index of the sigil in the draft, so accepting can rewrite exactly that token. */
  start: number
}

export function tokenOpeningWord(draft: string, caret: number, sigil: string): CompletionToken | null {
  let start = caret
  while (start > 0 && !/\s/.test(draft[start - 1])) start -= 1
  if (draft[start] !== sigil) return null
  return { query: draft.slice(start + 1, caret), start }
}

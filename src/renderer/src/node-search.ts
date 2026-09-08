/**
 * In-node search: the key that opens it, and the arithmetic behind a find bar. Both halves are
 * pure so the shortcut can be tested without a DOM and the find bar's counting without a render.
 * `FindBar.tsx` is the shared UI over this; nodes that render plain DOM text (file, and later
 * AI-chat and diff nodes) use it. CodeMirror is virtualized, so the raw file view searches through
 * `@codemirror/search` instead and only borrows the shortcut.
 */

/** The subset of `KeyboardEvent` the search shortcut reads, so callers can test without a DOM. */
export interface NodeSearchShortcutKey {
  key: string
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
  metaKey: boolean
}

export interface NodeSearchKeyContext {
  /** Whether the key went to an input, textarea or editable element, which owns Ctrl+F itself. */
  editingText: boolean
  /** Whether a modal dialog is open; the node behind it is not what the reader is looking at. */
  dialogOpen: boolean
}

/**
 * Ctrl+F opens search in the node the reader is on. It yields inside text fields on purpose: a
 * composer, a find bar's own input and CodeMirror's editable content all bind Ctrl+F themselves,
 * and a global handler that took it there would search the wrong surface - or search nothing while
 * the reader is typing into a search box. Shift/Alt/Meta variants are left unclaimed.
 */
export function nodeSearchKeyAction(event: NodeSearchShortcutKey, context: NodeSearchKeyContext): 'open' | 'none' {
  if (context.editingText || context.dialogOpen) return 'none'
  const wanted = event.ctrlKey && !event.shiftKey && !event.altKey && !event.metaKey
  return wanted && event.key.toLocaleLowerCase() === 'f' ? 'open' : 'none'
}

/** Half-open `[start, end)` offsets into the text a find bar was given. */
export interface TextMatch {
  start: number
  end: number
}

/**
 * Every non-overlapping occurrence of `query` in `text`, case-insensitively and literally - a find
 * bar takes what was typed, not a pattern. Lowercasing can change a string's length for a handful
 * of characters (Turkish dotted capitals among them), which would slide every later offset off its
 * match, so a text that does not lowercase one-for-one is searched case-sensitively instead.
 */
export function findMatchRanges(text: string, query: string): TextMatch[] {
  if (query === '') return []
  const foldedText = text.toLowerCase()
  const foldedQuery = query.toLowerCase()
  const foldable = foldedText.length === text.length && foldedQuery.length === query.length
  const haystack = foldable ? foldedText : text
  const needle = foldable ? foldedQuery : query
  const matches: TextMatch[] = []
  for (let from = haystack.indexOf(needle); from !== -1; from = haystack.indexOf(needle, from + needle.length)) {
    matches.push({ start: from, end: from + needle.length })
  }
  return matches
}

/** Next (`1`) or previous (`-1`) match, wrapping at both ends; `-1` when there is nothing to step. */
export function stepMatchIndex(total: number, current: number, direction: 1 | -1): number {
  if (total <= 0) return -1
  const from = current < 0 ? (direction === 1 ? -1 : 0) : current
  return (((from + direction) % total) + total) % total
}

/** What the find bar reports beside its input once there is a query: a position, or that there is none. */
export function matchCountLabel(total: number, current: number): string {
  return total === 0 ? 'No results' : `${current + 1} of ${total}`
}

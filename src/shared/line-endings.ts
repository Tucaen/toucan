/**
 * The one rule for which line ending a document speaks, so reading a file and writing it back
 * never converts it. A file node's editor cannot carry the distinction - CodeMirror splits a
 * document on CRLF and re-joins it with LF - so the ending is read off the bytes on disk, carried
 * beside the text, and put back on the way out. Without that, saving one character in a file a
 * Windows tool wrote shows the whole file as changed in git.
 *
 * Deliberately not the rule `frontmatter.ts` applies to a Markdown record: that one asks whether
 * *any* line carries a carriage return, because it is appending lines to a block it must not
 * leave half-converted. This one asks which ending the document mostly uses, because it decides
 * what the whole file is written as.
 */

export type LineEnding = 'lf' | 'crlf'

/**
 * The ending most of `text`'s line breaks use. A text with no line break at all is `lf`: there is
 * nothing to preserve, and LF is what every non-Windows tool would have written.
 */
export function dominantLineEnding(text: string): LineEnding {
  let crlf = 0
  let lf = 0
  for (let index = text.indexOf('\n'); index >= 0; index = text.indexOf('\n', index + 1)) {
    if (index > 0 && text[index - 1] === '\r') crlf += 1
    else lf += 1
  }
  // A tie goes to CRLF: those line breaks are the ones a rewrite would destroy.
  return crlf > 0 && crlf >= lf ? 'crlf' : 'lf'
}

/** `text` with every line break written as `ending`. Idempotent; a lone `\r` is left as it is. */
export function applyLineEnding(text: string, ending: LineEnding): string {
  return text.replace(/\r?\n/g, ending === 'crlf' ? '\r\n' : '\n')
}

export function isLineEnding(value: unknown): value is LineEnding {
  return value === 'lf' || value === 'crlf'
}

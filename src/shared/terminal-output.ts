/**
 * Turning what a terminal emitted into what a reader should see. Shared rather than renderer-local
 * because two very different readers need the same answer: the transcript's shell cards, and the
 * agent reading a connected terminal through the terminal-context edge (`terminal-context.ts`).
 * Both are handed text that a terminal emulator would have interpreted, and neither interprets it.
 */

// Matches CSI/OSC sequences and the stray escapes a truncated stream leaves behind. Output reaches
// its reader as text, so an unstripped sequence would be shown verbatim.
const ANSI_SEQUENCE = new RegExp(
  [
    '\\u001B\\][^\\u0007\\u001B]*(?:\\u0007|\\u001B\\\\)',
    '\\u001B[[\\]()#;?][0-9;?]*[\\u0020-\\u002F]*[\\u0040-\\u007E]',
    '\\u001B[\\u0040-\\u005A\\u005C-\\u005F]',
    '[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F]'
  ].join('|'),
  'g'
)

/**
 * Strips the control bytes a terminal would have consumed rather than shown: ANSI colour and
 * cursor sequences, and the carriage returns a progress bar uses to rewrite its line - only the
 * final state of such a line is meaningful, and keeping every rewrite would show one download as
 * a hundred lines.
 */
export function normalizeTerminalOutput(text: string): string {
  return text
    .replace(ANSI_SEQUENCE, '')
    .split('\n')
    .map((line) => {
      const withoutTrailing = line.replace(/\r+$/, '')
      if (!withoutTrailing.includes('\r')) return withoutTrailing
      const segments = withoutTrailing.split('\r')
      return segments.at(-1) || segments.filter(Boolean).at(-1) || ''
    })
    .join('\n')
}

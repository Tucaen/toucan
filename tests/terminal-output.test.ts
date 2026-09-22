import { strict as assert } from 'node:assert'
import { test } from 'vitest'
import { normalizeTerminalOutput } from '../src/shared/terminal-output'

const ESC = String.fromCharCode(0x1b)
const BEL = String.fromCharCode(0x07)
/** Written by code point rather than literally, so an invisible byte is still readable source. */
const control = (code: number): string => String.fromCharCode(code)

test('ANSI colour, cursor moves and progress-bar rewrites never reach the reader', () => {
  assert.equal(normalizeTerminalOutput(`${ESC}[32mPASS${ESC}[0m tests/a.test.ts`), 'PASS tests/a.test.ts')
  assert.equal(normalizeTerminalOutput(`${ESC}]0;window title${BEL}done`), 'done')
  assert.equal(normalizeTerminalOutput(`${ESC}[2K${ESC}[1Gbuilding`), 'building')
  // A download rewriting its line is one line, not a hundred.
  assert.equal(normalizeTerminalOutput('10%\r55%\r100%'), '100%')
  assert.equal(normalizeTerminalOutput('first\r\nsecond\r\n'), 'first\nsecond\n')
})

test('an OSC terminated by ESC-backslash is stripped as completely as a BEL-terminated one', () => {
  assert.equal(normalizeTerminalOutput(`${ESC}]0;window title${ESC}\\done`), 'done')
  assert.equal(normalizeTerminalOutput(`${ESC}]8;;https://example.com${ESC}\\link`), 'link')
})

test('the stray escapes a truncated stream leaves behind never reach the reader', () => {
  // A chunk boundary can cut a sequence in half, so a bare ESC plus its final byte has to go too.
  assert.equal(normalizeTerminalOutput(`${ESC}Mrolled up`), 'rolled up')
  assert.equal(normalizeTerminalOutput(`${ESC}Dindex`), 'index')
  // Only the escapes whose final byte is in the Fe/Fs range are recognised: `ESC =` (keypad mode)
  // is outside it, so its `=` survives as text. Harmless, and pinned so a widened range is a choice.
  assert.equal(normalizeTerminalOutput(`${ESC}=keypad`), '=keypad')
})

test('C0 control bytes and DEL are consumed, while tab and newline stay text', () => {
  assert.equal(normalizeTerminalOutput(`bell${control(0x07)}end`), 'bellend')
  assert.equal(normalizeTerminalOutput(`back${control(0x08)}space`), 'backspace')
  assert.equal(normalizeTerminalOutput(`vertical${control(0x0b)}tab`), 'verticaltab')
  assert.equal(normalizeTerminalOutput(`del${control(0x7f)}ete`), 'delete')
  // The two a reader is meant to see survive.
  assert.equal(normalizeTerminalOutput('a\tb\nc'), 'a\tb\nc')
})

test('a line rewritten down to nothing is empty, not a leftover from somewhere else', () => {
  // Every segment empty is the branch where both fallbacks run out; it has to answer with ''.
  assert.equal(normalizeTerminalOutput('\r\r\r'), '')
  assert.equal(normalizeTerminalOutput(''), '')
  assert.equal(normalizeTerminalOutput('progress\r\r'), 'progress')
  // A final carriage return that clears the line keeps the last non-empty rewrite instead.
  assert.equal(normalizeTerminalOutput('55%\r100%\r'), '100%')
})

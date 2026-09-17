import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { normalizeTerminalOutput } from '../src/shared/terminal-output'

const ESC = String.fromCharCode(0x1b)
const BEL = String.fromCharCode(0x07)

test('ANSI colour, cursor moves and progress-bar rewrites never reach the reader', () => {
  assert.equal(normalizeTerminalOutput(`${ESC}[32mPASS${ESC}[0m tests/a.test.ts`), 'PASS tests/a.test.ts')
  assert.equal(normalizeTerminalOutput(`${ESC}]0;window title${BEL}done`), 'done')
  assert.equal(normalizeTerminalOutput(`${ESC}[2K${ESC}[1Gbuilding`), 'building')
  // A download rewriting its line is one line, not a hundred.
  assert.equal(normalizeTerminalOutput('10%\r55%\r100%'), '100%')
  assert.equal(normalizeTerminalOutput('first\r\nsecond\r\n'), 'first\nsecond\n')
})

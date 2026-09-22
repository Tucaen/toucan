import { strict as assert } from 'node:assert'
import { globSync, readFileSync } from 'node:fs'
import { test } from 'vitest'
import { applyLineEnding, dominantLineEnding } from '../src/shared/line-endings'

test('a file speaks one line ending, and the one it speaks most is the one it keeps', () => {
  assert.equal(dominantLineEnding('a\r\nb\r\n'), 'crlf')
  assert.equal(dominantLineEnding('a\nb\n'), 'lf')
  // Nothing to go on: a single line, or no text at all, is not a Windows file.
  assert.equal(dominantLineEnding('no newline here'), 'lf')
  assert.equal(dominantLineEnding(''), 'lf')
  // Mixed: the majority decides, and a tie goes to CRLF because those lines cannot be preserved
  // by leaving the file alone while the LF ones can.
  assert.equal(dominantLineEnding('a\r\nb\r\nc\n'), 'crlf')
  assert.equal(dominantLineEnding('a\r\nb\nc\n'), 'lf')
  assert.equal(dominantLineEnding('a\r\nb\n'), 'crlf')
})

test('applying a line ending rewrites every line break and leaves the text alone', () => {
  assert.equal(applyLineEnding('a\nb\r\nc', 'crlf'), 'a\r\nb\r\nc')
  assert.equal(applyLineEnding('a\r\nb\nc', 'lf'), 'a\nb\nc')
  // Idempotent, so a caller that cannot tell whether the text was already converted may convert.
  assert.equal(applyLineEnding(applyLineEnding('a\nb', 'crlf'), 'crlf'), 'a\r\nb')
  // A lone carriage return is a character in the line, not a break this module invented a rule for.
  assert.equal(applyLineEnding('a\rb\n', 'crlf'), 'a\rb\r\n')
})

/** A single-quoted literal that opens with a drive letter, which is how every path fixture is written. */
const DRIVE_PATH_LITERAL = /'[A-Za-z]:[^']*'/g
/** Every recognized escape, removed left to right so what is left is only unpaired backslashes. */
const ESCAPE = /\\[\\nrt']/g

/**
 * A Windows path in a TypeScript literal needs its backslashes doubled, and the failure mode when
 * it does not have them is silence: a single backslash before a letter opens no escape, so the
 * literal is valid and simply loses the separator. Neither tsc, eslint nor prettier says anything,
 * and a fixture mangled this way still passes every assertion written against the same mangled
 * literal - it just stops being a Windows path, which is the one thing it exists to be. Found in
 * six fixtures at once while consolidating the DOM harness (#238), and in four others that had
 * been wrong for months.
 */
test('every drive-letter path literal in the suite is a real Windows path', () => {
  const offenders: string[] = []
  for (const file of globSync('tests/**/*.ts*')) {
    for (const [index, line] of readFileSync(file, 'utf8').split('\n').entries()) {
      // Comments are skipped so this test's own prose about the bug is not read as the bug.
      if (line.trimStart().startsWith('*') || line.trimStart().startsWith('//')) continue
      for (const match of line.matchAll(DRIVE_PATH_LITERAL)) {
        if (match[0].replace(ESCAPE, '').includes('\\')) offenders.push(`${file}:${index + 1} ${match[0]}`)
      }
    }
  }
  assert.deepEqual(offenders, [])
})

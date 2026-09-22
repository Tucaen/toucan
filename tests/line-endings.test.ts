import { strict as assert } from 'node:assert'
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

import { deepEqual, equal, throws } from 'node:assert/strict'
import { test } from 'node:test'
import { parseFrontmatter, rewriteFrontmatter } from '../src/shared/frontmatter'

// The one frontmatter reader and writer behind every one-file-per-record collection: brain-dump
// topics and tickets. Fields are flat `key: value` lines; the body is whatever follows and is
// never reinterpreted.

function fields(markdown: string): Record<string, string> {
  const result = parseFrontmatter(markdown)
  if (!result.ok) throw new Error(`Expected valid frontmatter, got: ${result.message}`)
  return Object.fromEntries(result.fields)
}

test('a valid document yields its fields and the body that follows the closing delimiter', () => {
  const result = parseFrontmatter('---\ntitle: A ticket\nstatus: open\n---\n\nBody line.\n')
  equal(result.ok, true)
  if (!result.ok) return
  deepEqual(Object.fromEntries(result.fields), { title: 'A ticket', status: 'open' })
  equal(result.body, '\nBody line.\n')
})

test('values keep their inner punctuation and lose only surrounding whitespace', () => {
  deepEqual(fields('---\ntitle:   Fix: the thing, twice  \n---\n'), { title: 'Fix: the thing, twice' })
})

test('an empty value is a present field, not a missing one', () => {
  deepEqual(fields('---\nblocked_by:\n---\n'), { blocked_by: '' })
})

test('blank lines and comments inside the frontmatter are ignored', () => {
  deepEqual(fields('---\ntitle: A\n\n# a note\n  \nstatus: open\n---\n'), { title: 'A', status: 'open' })
})

test('a document without frontmatter is an error naming what it was meant to be', () => {
  const result = parseFrontmatter('# No frontmatter\n', 'Ticket')
  equal(result.ok, false)
  if (result.ok) return
  equal(result.message, 'Ticket must start with YAML frontmatter.')
})

test('an unterminated frontmatter block is an error', () => {
  const result = parseFrontmatter('---\ntitle: A\n')
  equal(result.ok, false)
})

test('a line that is neither a field nor ignorable is reported with its line number', () => {
  const result = parseFrontmatter('---\ntitle: A\njust prose\n---\n')
  equal(result.ok, false)
  if (result.ok) return
  equal(result.message.includes('3'), true)
})

test('a duplicate field is an error rather than a silent last-wins', () => {
  const result = parseFrontmatter('---\ntitle: A\ntitle: B\n---\n')
  equal(result.ok, false)
  if (result.ok) return
  equal(result.message.includes('title'), true)
})

test('rewriting a field leaves the body byte-for-byte intact', () => {
  const body = '\nBody with --- inside it,\nand a trailing blank line.\n\n'
  const rewritten = rewriteFrontmatter(`---\nstatus: open\nupdated: 2026-09-01\n---${body}`, {
    status: 'done',
    updated: '2026-09-04'
  })
  equal(rewritten, `---\nstatus: done\nupdated: 2026-09-04\n---${body}`)
})

test('rewriting keeps existing field order and appends only genuinely new fields', () => {
  equal(
    rewriteFrontmatter('---\ntitle: A\nstatus: open\n---\nBody\n', { status: 'done', blocked_by: 'other' }),
    '---\ntitle: A\nstatus: done\nblocked_by: other\n---\nBody\n'
  )
})

test('an undefined update removes the field, and removing an absent field is a no-op', () => {
  equal(
    rewriteFrontmatter('---\ntitle: A\nblocked_by: other\n---\nBody\n', { blocked_by: undefined, absent: undefined }),
    '---\ntitle: A\n---\nBody\n'
  )
})

test('rewriting a document that has no frontmatter refuses rather than inventing one', () => {
  throws(() => rewriteFrontmatter('# No frontmatter\n', { status: 'done' }), /frontmatter/i)
})

test('the label defaults to a neutral word, so a caller need not supply one', () => {
  const result = parseFrontmatter('# No frontmatter\n')
  equal(result.ok, false)
  if (result.ok) return
  equal(result.message, 'Document must start with YAML frontmatter.')
})

import { deepEqual, equal, throws } from 'node:assert/strict'
import { test } from 'node:test'
import {
  frontmatterForDisplay,
  lenientFrontmatter,
  parseFrontmatter,
  rewriteFrontmatter,
  upsertFrontmatter
} from '../src/shared/frontmatter'

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

// The viewer's reader: every document renders, whatever its block contains.

test('a document displays its frontmatter as ordered fields and the body below it', () => {
  const shown = frontmatterForDisplay('---\nname: jira-ticket\ndescription: Create a ticket.\n---\n\n# Jira ticket\n')
  deepEqual(shown?.fields, [
    { key: 'name', value: 'jira-ticket' },
    { key: 'description', value: 'Create a ticket.' }
  ])
  equal(shown?.body, '\n# Jira ticket\n')
})

test('a nested or wrapped line continues the field above it instead of failing the document', () => {
  const shown = frontmatterForDisplay('---\nallowed-tools:\n  - Read\n  - Edit\nname: a\n---\n')
  deepEqual(shown?.fields, [
    { key: 'allowed-tools', value: '- Read\n- Edit' },
    { key: 'name', value: 'a' }
  ])
})

test('a repeated field is shown twice rather than rejected, because disk says so', () => {
  deepEqual(frontmatterForDisplay('---\nname: a\nname: b\n---\n')?.fields, [
    { key: 'name', value: 'a' },
    { key: 'name', value: 'b' }
  ])
})

test('a document with no closed frontmatter block has nothing to lift out', () => {
  equal(frontmatterForDisplay('# Plan\n\nBody.\n'), undefined)
  equal(frontmatterForDisplay('---\nname: a\n'), undefined)
})

// The lenient reader and writer: a notepad file is still a record, so nothing here rejects one.

test('lenient reading takes the fields it can and never fails on the rest', () => {
  const read = lenientFrontmatter(
    ['---', 'title: A', 'not a field', '  nested: thing', '# comment', 'status: open', '---', '', 'Body.\n'].join('\n')
  )
  deepEqual(
    [...read.fields],
    [
      ['title', 'A'],
      ['status', 'open']
    ]
  )
  equal(read.body, '\nBody.\n')
})

test('lenient reading keeps the first of a duplicated field rather than rejecting the file', () => {
  deepEqual([...lenientFrontmatter('---\nstatus: open\nstatus: done\n---\nBody\n').fields], [['status', 'open']])
})

test('a note that opens with a horizontal rule keeps its prose, rather than losing it to a block', () => {
  // Two `---` lines with nothing field-shaped between them is a rule, not frontmatter: reading it
  // as a block would lift the first paragraph out of the body and nothing would ever show it.
  const note = '---\nSomething someone typed.\n---\nAnd more below.\n'
  const read = lenientFrontmatter(note)

  deepEqual([...read.fields], [])
  equal(read.body, note)
  // The writer has to agree, or it would edit a block the reader never saw.
  equal(upsertFrontmatter(note, { status: 'done' }), `---\nstatus: done\n---\n\n${note}`)
})

test('a document with no closed block is all body, with no fields', () => {
  const read = lenientFrontmatter('# Just a heading\n\nProse.\n')
  deepEqual([...read.fields], [])
  equal(read.body, '# Just a heading\n\nProse.\n')
  deepEqual([...lenientFrontmatter('---\ntitle: A\nnever closed\n').fields], [])
})

test('upserting into a document without frontmatter writes a block above the text it keeps', () => {
  equal(
    upsertFrontmatter('# Heading\n\nProse.\n', { status: 'done', updated: '2026-09-04' }),
    '---\nstatus: done\nupdated: 2026-09-04\n---\n\n# Heading\n\nProse.\n'
  )
})

test('upserting into a block rewrites in place, keeps lines it cannot read, and drops duplicates it replaced', () => {
  equal(
    upsertFrontmatter('---\ntitle: A\nnot a field\nstatus: open\nstatus: blocked\n---\nBody\n', { status: 'done' }),
    '---\ntitle: A\nnot a field\nstatus: done\n---\nBody\n'
  )
})

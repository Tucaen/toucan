import { deepEqual, equal, match, ok, throws } from 'node:assert/strict'
import { test } from 'node:test'
import {
  TICKET_FIELDS,
  TICKET_FORMAT_BLOCKED_BY,
  TICKET_FORMAT_FILENAME,
  TICKET_FORMAT_UNKNOWN_STATUS,
  exampleTicketMarkdown,
  ticketLocationNote,
  TICKET_FIELD_SENTENCE
} from '../src/shared/ticket-format'
import { DEFAULT_TICKET_STATUSES, parseTicket } from '../src/shared/tickets'

/**
 * The format primer is the fourth surface the ticket convention is written on, and the only one a
 * human reads. These tests are the lock that keeps it honest: every claim it makes is checked
 * against `parseTicket`, which is what actually decides. A primer that taught a shape the parser
 * rejects would be worse than no primer at all.
 */

const EXAMPLE_SLUG = 'ticket-board'
const TODAY = '2026-09-20'

test('the example the primer shows is itself a conforming ticket', () => {
  const ticket = parseTicket(exampleTicketMarkdown(TODAY), EXAMPLE_SLUG)

  equal(ticket.slug, EXAMPLE_SLUG)
  equal(ticket.created, TODAY)
  equal(ticket.updated, TODAY)
  equal(ticket.status, DEFAULT_TICKET_STATUSES[0])
  ok(ticket.title.length > 0)
  ok(ticket.body.trim().length > 0)
})

/** Frontmatter keys the example actually sets, ignoring the ones it shows commented out. */
function exampleKeys(markdown: string): string[] {
  return markdown
    .split('---')[1]
    .split('\n')
    .filter((line) => line.trim() && !line.startsWith('#'))
    .map((line) => line.split(':')[0].trim())
}

test('the example uses only fields the primer names', () => {
  const named = TICKET_FIELDS.map((field) => field.name)

  ok(exampleKeys(exampleTicketMarkdown(TODAY)).every((key) => named.includes(key)))
})

test('the example sets every required field and no optional one', () => {
  const keys = exampleKeys(exampleTicketMarkdown(TODAY))

  deepEqual(
    keys,
    TICKET_FIELDS.filter((field) => field.required).map((field) => field.name)
  )
  // Pasted as it stands it must not produce the flagged blocker chip the primer warns about.
  deepEqual(parseTicket(exampleTicketMarkdown(TODAY), EXAMPLE_SLUG).blockedBy, [])
})

test('every field the primer calls required really is', () => {
  for (const field of TICKET_FIELDS) {
    if (!field.required) continue
    const without = exampleTicketMarkdown(TODAY)
      .split('\n')
      .filter((line) => !line.startsWith(`${field.name}:`))
      .join('\n')
    throws(() => parseTicket(without, EXAMPLE_SLUG), new RegExp(field.name))
  }
})

test('every field the primer calls optional really is', () => {
  const optional = TICKET_FIELDS.filter((field) => !field.required)
  ok(optional.length > 0)
  for (const field of optional) {
    // Added to the example rather than removed from it: the example already omits every optional
    // field, so what is worth proving is that writing one is still a conforming ticket.
    const lines = exampleTicketMarkdown(TODAY).split('\n')
    lines.splice(lines.indexOf('---', 1), 0, `${field.name}: shared-frontmatter`)
    const ticket = parseTicket(lines.join('\n'), EXAMPLE_SLUG)
    equal(ticket.slug, EXAMPLE_SLUG)
  }
})

test('the location note names the project’s own folder, and the default when it moved', () => {
  const paths = (directory: string): string[] =>
    ticketLocationNote(directory).flatMap((segment) => ('path' in segment ? [segment.path] : []))

  deepEqual(paths('docs/tickets'), ['docs/tickets'])
  // A project that moved them is told both: where its tickets are, and what it changed away from.
  deepEqual(paths('notes/tickets'), ['notes/tickets', 'docs/tickets'])
})

test('the primer says what the board loses when an optional field is absent', () => {
  for (const field of TICKET_FIELDS) ok(field.whenAbsent.length > 0, `${field.name} says nothing about absence`)
})

test('the agent-facing sentence enumerates exactly the fields the primer does', () => {
  const sentence = TICKET_FIELD_SENTENCE

  for (const field of TICKET_FIELDS) match(sentence, new RegExp(`\`${field.name}\``))
  // Required and optional are not one list: an agent told `blocked_by` is required would add it.
  match(sentence, /optionally `blocked_by`/)
})

test('the prose the primer shows names the things the board actually does with a file', () => {
  deepEqual(
    TICKET_FIELDS.map((field) => field.name),
    ['title', 'status', 'created', 'updated', 'blocked_by']
  )
  match(TICKET_FORMAT_FILENAME, /kebab-case/)
  match(TICKET_FORMAT_UNKNOWN_STATUS, /column/)
  match(TICKET_FORMAT_BLOCKED_BY, /same folder/)
})

import { deepEqual, equal, throws } from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_TICKETS_DIRECTORY, DEFAULT_TICKET_STATUSES, isTicketSlug, parseTicket } from '../src/shared/tickets'

// A ticket is its file. These are the rules that decide whether a file in the tickets folder is a
// ticket the board can render or a diagnostic row explaining why it is not.

const valid = [
  '---',
  'title: Add a ticket board',
  'status: in-progress',
  'created: 2026-09-01',
  'updated: 2026-09-04',
  'blocked_by: ticket-file-convention, shared-frontmatter',
  '---',
  '',
  'Body prose.',
  ''
].join('\n')

test('a valid file becomes a ticket keyed by its slug, body and markdown preserved', () => {
  deepEqual(parseTicket(valid, 'ticket-board'), {
    slug: 'ticket-board',
    title: 'Add a ticket board',
    status: 'in-progress',
    created: '2026-09-01',
    updated: '2026-09-04',
    blockedBy: ['ticket-file-convention', 'shared-frontmatter'],
    body: '\nBody prose.\n',
    markdown: valid
  })
})

test('blocked_by is optional and absent means nothing blocks the ticket', () => {
  const ticket = parseTicket('---\ntitle: A\nstatus: open\ncreated: 2026-09-01\nupdated: 2026-09-01\n---\n', 'a')
  deepEqual(ticket.blockedBy, [])
})

test('an empty blocked_by reads the same as an absent one', () => {
  const ticket = parseTicket(
    '---\ntitle: A\nstatus: open\ncreated: 2026-09-01\nupdated: 2026-09-01\nblocked_by:\n---\n',
    'a'
  )
  deepEqual(ticket.blockedBy, [])
})

test('an unknown status is tolerated so a project can invent a column', () => {
  equal(parseTicket(valid.replace('status: in-progress', 'status: review'), 'a').status, 'review')
  equal(DEFAULT_TICKET_STATUSES.includes('review' as never), false)
})

test('a status Toucan would never render as a tidy column is still tolerated, not rejected', () => {
  equal(
    parseTicket(valid.replace('status: in-progress', 'status: In Review (blocked)'), 'a').status,
    'In Review (blocked)'
  )
})

test('the default columns are the four documented statuses, in board order', () => {
  deepEqual([...DEFAULT_TICKET_STATUSES], ['open', 'in-progress', 'blocked', 'done'])
})

test('the default folder is the one the skill tells agents to write into', () => {
  equal(DEFAULT_TICKETS_DIRECTORY, 'docs/tickets')
})

for (const field of ['title', 'status', 'created', 'updated']) {
  test(`a missing ${field} is an error naming the field`, () => {
    const missing = valid
      .split('\n')
      .filter((line) => !line.startsWith(`${field}:`))
      .join('\n')
    throws(() => parseTicket(missing, 'a'), new RegExp(field))
  })
}

test('a blank required field is missing, not empty', () => {
  throws(() => parseTicket(valid.replace('title: Add a ticket board', 'title:'), 'a'), /title/)
})

test('a duplicated field is an error rather than a silent last-wins', () => {
  throws(() => parseTicket(valid.replace('status: in-progress', 'status: open\nstatus: done'), 'a'), /status/)
})

test('a date that is not YYYY-MM-DD is an error', () => {
  throws(() => parseTicket(valid.replace('created: 2026-09-01', 'created: 09/01/2026'), 'a'), /created/)
})

test('blocked_by entries that are not slugs are an error, not silently dropped links', () => {
  throws(() => parseTicket(valid.replace('shared-frontmatter', 'Shared Frontmatter'), 'a'), /blocked_by/)
})

test('a trailing separator in blocked_by is an error rather than an empty reference', () => {
  throws(() => parseTicket(valid.replace('shared-frontmatter', 'shared-frontmatter,'), 'a'), /blocked_by/)
})

test('a ticket cannot block itself', () => {
  throws(() => parseTicket(valid.replace('shared-frontmatter', 'ticket-board'), 'ticket-board'), /blocked_by/)
})

test('a repeated blocker is listed once, in first-mention order', () => {
  deepEqual(parseTicket(valid.replace('shared-frontmatter', 'ticket-file-convention'), 'a').blockedBy, [
    'ticket-file-convention'
  ])
})

test('a filename that is not a slug is an error, because the filename is the id', () => {
  throws(() => parseTicket(valid, 'My Ticket'), /[Ff]ilename/)
})

test('a file with no frontmatter says which collection it failed to be', () => {
  throws(() => parseTicket('# Just a heading\n', 'a'), /Ticket must start with YAML frontmatter/)
})

test('slugs are lowercase kebab-case, which is also what the filename must be', () => {
  for (const slug of ['a', 'ticket-board', 'issue-142']) equal(isTicketSlug(slug), true, slug)
  for (const slug of ['Ticket-Board', 'ticket_board', 'ticket--board', '-ticket', 'ticket-', '', 'ticket board'])
    equal(isTicketSlug(slug), false, slug)
})

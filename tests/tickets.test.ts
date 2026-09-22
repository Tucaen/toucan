import { deepEqual, equal } from 'node:assert/strict'
import { test } from 'vitest'
import {
  DEFAULT_TICKETS_DIRECTORY,
  DEFAULT_TICKET_STATUSES,
  TICKET_STATUS,
  isTicketSlug,
  ticketsDirectoryOrDefault,
  readTicket
} from '../src/shared/tickets'

// A ticket is its file, and a file in the tickets folder is a notepad before it is a record: the
// board shows every one of them. These are the rules that decide what a card says when the file
// does not spell it out - and the one thing that is never done, which is inventing a date.

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

test('a fully written file becomes a ticket keyed by its slug, body and markdown preserved', () => {
  deepEqual(readTicket(valid, 'ticket-board'), {
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
  const ticket = readTicket('---\ntitle: A\nstatus: open\ncreated: 2026-09-01\nupdated: 2026-09-01\n---\n', 'a')
  deepEqual(ticket.blockedBy, [])
})

test('an empty blocked_by reads the same as an absent one', () => {
  const ticket = readTicket(
    '---\ntitle: A\nstatus: open\ncreated: 2026-09-01\nupdated: 2026-09-01\nblocked_by:\n---\n',
    'a'
  )
  deepEqual(ticket.blockedBy, [])
})

test('an unknown status is tolerated so a project can invent a column', () => {
  equal(readTicket(valid.replace('status: in-progress', 'status: review'), 'a').status, 'review')
  equal(DEFAULT_TICKET_STATUSES.includes('review' as never), false)
})

test('a status Toucan would never render as a tidy column is still tolerated, not rejected', () => {
  equal(
    readTicket(valid.replace('status: in-progress', 'status: In Review (blocked)'), 'a').status,
    'In Review (blocked)'
  )
})

test('the default columns are the four documented statuses, in board order', () => {
  deepEqual([...DEFAULT_TICKET_STATUSES], ['open', 'in-progress', 'blocked', 'done'])
})

test('the default folder is the one the skill tells agents to write into', () => {
  equal(DEFAULT_TICKETS_DIRECTORY, 'docs/tickets')
})

// A hand-written note is the case the board exists to tolerate: no frontmatter, no fields, just
// something someone typed into the folder.

test('a file with no frontmatter at all is still a ticket, titled from its first heading', () => {
  const ticket = readTicket('# Look into the flaky test\n\nIt fails on Windows only.\n', 'flaky-test')

  equal(ticket.title, 'Look into the flaky test')
  equal(ticket.status, TICKET_STATUS.open)
  equal(ticket.created, undefined)
  equal(ticket.updated, undefined)
  deepEqual(ticket.blockedBy, [])
  // Nothing was lifted out of it, so the whole note is the body the detail pane renders.
  equal(ticket.body, '# Look into the flaky test\n\nIt fails on Windows only.\n')
})

test('a heading at any level titles the card, and only the first one does', () => {
  equal(readTicket('## Notes\n\n# Later\n', 'notes').title, 'Notes')
  equal(readTicket('Prose first.\n\n### Then a heading\n', 'notes').title, 'Then a heading')
})

test('a note with no heading falls back to its filename, never to an empty card', () => {
  equal(readTicket('Just some prose.\n', 'rate-limit-spike').title, 'rate-limit-spike')
  equal(readTicket('', 'empty-note').title, 'empty-note')
  // A `#` with nothing after it is not a heading anyone wrote a title into.
  equal(readTicket('#\n\nProse.\n', 'hash-only').title, 'hash-only')
})

test('a missing status puts the card in the default column rather than off the board', () => {
  equal(readTicket('---\ntitle: A\n---\nBody\n', 'a').status, TICKET_STATUS.open)
  equal(readTicket('---\ntitle: A\nstatus:\n---\nBody\n', 'a').status, TICKET_STATUS.open)
})

test('a blank title falls back the same way an absent one does', () => {
  equal(readTicket('---\ntitle:\n---\n\n# From the heading\n', 'a').title, 'From the heading')
})

test('a date that is not YYYY-MM-DD is absent rather than shown, because a card never invents one', () => {
  const ticket = readTicket('---\ntitle: A\ncreated: 09/01/2026\nupdated: soon\n---\nBody\n', 'a')

  equal(ticket.created, undefined)
  equal(ticket.updated, undefined)
})

test('an unparseable frontmatter line is ignored for the card and left in the file', () => {
  const markdown = '---\ntitle: A\nthis line is not a field\nstatus: blocked\n---\nBody\n'
  const ticket = readTicket(markdown, 'a')

  equal(ticket.title, 'A')
  equal(ticket.status, 'blocked')
  equal(ticket.markdown, markdown)
})

test('a duplicated field takes the first value rather than making the file unreadable', () => {
  equal(readTicket('---\nstatus: open\nstatus: done\n---\nBody\n', 'a').status, 'open')
})

test('an unterminated frontmatter block is prose, not a broken record', () => {
  const ticket = readTicket('---\ntitle: A\nnever closed\n', 'a')

  equal(ticket.title, 'a')
  equal(ticket.body, '---\ntitle: A\nnever closed\n')
})

test('a blocked_by entry that is not a slug is kept as written, for the board to flag', () => {
  deepEqual(readTicket(valid.replace('shared-frontmatter', 'Shared Frontmatter'), 'a').blockedBy, [
    'ticket-file-convention',
    'Shared Frontmatter'
  ])
})

test('a trailing separator in blocked_by is an empty reference nobody meant, so it is dropped', () => {
  deepEqual(readTicket('---\nblocked_by: one, , two,\n---\n', 'a').blockedBy, ['one', 'two'])
})

test('a ticket never blocks itself, however the file spells it', () => {
  deepEqual(readTicket(valid.replace('shared-frontmatter', 'ticket-board'), 'ticket-board').blockedBy, [
    'ticket-file-convention'
  ])
})

test('a repeated blocker is listed once, in first-mention order', () => {
  deepEqual(readTicket(valid.replace('shared-frontmatter', 'ticket-file-convention'), 'a').blockedBy, [
    'ticket-file-convention'
  ])
})

test('slugs are lowercase kebab-case, which is also what the filename must be', () => {
  for (const slug of ['a', 'ticket-board', 'issue-142']) equal(isTicketSlug(slug), true, slug)
  for (const slug of ['Ticket-Board', 'ticket_board', 'ticket--board', '-ticket', 'ticket-', '', 'ticket board'])
    equal(isTicketSlug(slug), false, slug)
})

test('a project keeps tickets where it said, unless where it said leaves the checkout', () => {
  equal(ticketsDirectoryOrDefault('docs/board'), 'docs/board')
  equal(ticketsDirectoryOrDefault('  docs/board  '), 'docs/board')
  equal(ticketsDirectoryOrDefault('tickets'), 'tickets')

  // Absent, blank, escaping, or absolute all mean the default: a configured value that leaves the
  // checkout is ignored rather than obeyed, so no project setting can point the board at the disk.
  equal(ticketsDirectoryOrDefault(), DEFAULT_TICKETS_DIRECTORY)
  equal(ticketsDirectoryOrDefault(''), DEFAULT_TICKETS_DIRECTORY)
  equal(ticketsDirectoryOrDefault('   '), DEFAULT_TICKETS_DIRECTORY)
  equal(ticketsDirectoryOrDefault('../elsewhere'), DEFAULT_TICKETS_DIRECTORY)
  equal(ticketsDirectoryOrDefault('docs/../../escape'), DEFAULT_TICKETS_DIRECTORY)
  equal(ticketsDirectoryOrDefault('/etc'), DEFAULT_TICKETS_DIRECTORY)
  equal(ticketsDirectoryOrDefault('D:\\Development'), DEFAULT_TICKETS_DIRECTORY)
})

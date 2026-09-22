import { strict as assert } from 'node:assert'
import { test } from 'vitest'
import type { Ticket } from '../src/shared/tickets'
import { TICKET_FILES_SOURCE_ID, ticketCard, ticketCardKey } from '../src/shared/ticket-source'

/**
 * The one projection of a ticket file onto the board's source-neutral card. Optional fields are
 * omitted rather than sent as `undefined`, because the board treats "absent" as "this source
 * cannot say" - a key that is present and empty would claim it said nothing rather than nothing.
 */

function ticket(overrides: Partial<Ticket> = {}): Ticket {
  return { slug: 'split-terminal', title: 'Split terminal.ts', status: 'todo', blockedBy: [], body: '', ...overrides }
}

test('a ticket becomes a card of the files source, keyed by its own slug', () => {
  const card = ticketCard(ticket())

  assert.equal(card.sourceId, TICKET_FILES_SOURCE_ID)
  assert.equal(card.id, 'split-terminal')
  assert.equal(card.title, 'Split terminal.ts')
  assert.equal(card.status, 'todo')
  assert.equal(card.body, '')
})

test('what the file did not say is left off the card entirely', () => {
  const card = ticketCard(ticket())

  assert.equal('updated' in card, false)
  assert.equal('orderedAt' in card, false)
  assert.equal('blockedBy' in card, false)
})

test('what the file did say is carried through, including the mtime the caller had', () => {
  const card = ticketCard(ticket({ updated: '2026-09-21', blockedBy: ['anchor-remote'], body: '# Body' }), 1_700_000)

  assert.equal(card.updated, '2026-09-21')
  assert.deepEqual(card.blockedBy, ['anchor-remote'])
  assert.equal(card.orderedAt, 1_700_000)
  assert.equal(card.body, '# Body')
})

test('an orderedAt of zero is a real mtime and is kept, unlike an absent one', () => {
  // The guard is `=== undefined` rather than falsiness on purpose: the epoch is a valid mtime.
  assert.equal(ticketCard(ticket(), 0).orderedAt, 0)
})

test('the board key is scoped to the source, so two sources may both use the slug "board"', () => {
  assert.equal(ticketCardKey(ticketCard(ticket({ slug: 'board' }))), 'files:board')
  assert.notEqual(ticketCardKey({ sourceId: 'github', id: 'board' }), ticketCardKey({ sourceId: 'files', id: 'board' }))
})

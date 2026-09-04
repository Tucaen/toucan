import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import type { TicketCard, TicketSourceListResult } from '../src/shared/ticket-source'
import { ticketCardKey } from '../src/shared/ticket-source'
import {
  DONE_COLUMN_RECENT_DAYS,
  describeTicketDate,
  staleDoneCards,
  ticketBlockers,
  ticketBoardColumns,
  ticketDropAllowed,
  ticketStatusBeside,
  ticketStatusLabel
} from '../src/renderer/src/ticket-board'

const TODAY = '2026-09-04'

function card(overrides: Partial<TicketCard> & Pick<TicketCard, 'id'>): TicketCard {
  return {
    sourceId: 'files',
    title: overrides.id,
    status: 'open',
    updated: TODAY,
    ...overrides
  }
}

function listing(cards: TicketCard[], diagnostics: TicketSourceListResult['diagnostics'] = []): TicketSourceListResult {
  return { cards, diagnostics }
}

test('columns are the shipped statuses, then any the project invented', () => {
  const columns = ticketBoardColumns({
    listings: [listing([card({ id: 'a', status: 'review' }), card({ id: 'b', status: 'done' })])],
    today: TODAY,
    showAllDone: false
  })
  assert.deepEqual(
    columns.map((column) => column.status),
    ['open', 'in-progress', 'blocked', 'done', 'review']
  )
  assert.deepEqual(
    columns.map((column) => column.label),
    ['Open', 'In progress', 'Blocked', 'Done', 'Review']
  )
})

test('a column orders its cards by most recently updated, then by title', () => {
  const columns = ticketBoardColumns({
    listings: [
      listing([
        card({ id: 'stale', updated: '2026-08-01' }),
        card({ id: 'zebra', title: 'Zebra', updated: '2026-09-01' }),
        card({ id: 'apple', title: 'Apple', updated: '2026-09-01' })
      ])
    ],
    today: TODAY,
    showAllDone: false
  })
  const open = columns.find((column) => column.status === 'open')!
  assert.deepEqual(
    open.cards.map((entry) => entry.id),
    ['apple', 'zebra', 'stale']
  )
})

test('the Done column hides tickets closed longer ago than the cutoff until asked for all', () => {
  const cards = [
    card({ id: 'fresh', status: 'done', updated: '2026-09-01' }),
    card({ id: 'ancient', status: 'done', updated: '2026-01-01' })
  ]
  const collapsed = ticketBoardColumns({ listings: [listing(cards)], today: TODAY, showAllDone: false })
  const done = collapsed.find((column) => column.status === 'done')!
  assert.deepEqual(
    done.cards.map((entry) => entry.id),
    ['fresh']
  )
  assert.equal(done.hidden, 1)

  const all = ticketBoardColumns({ listings: [listing(cards)], today: TODAY, showAllDone: true })
  assert.equal(all.find((column) => column.status === 'done')!.cards.length, 2)
  assert.equal(all.find((column) => column.status === 'done')!.hidden, 0)
  assert.equal(DONE_COLUMN_RECENT_DAYS, 30)
})

test('cards from two sources share the columns and stay distinguishable', () => {
  const columns = ticketBoardColumns({
    listings: [
      listing([card({ id: 'board', sourceId: 'files', title: 'Board' })]),
      listing([card({ id: '145', sourceId: 'github', title: 'Board', updated: '2026-09-03' })])
    ],
    today: TODAY,
    showAllDone: false
  })
  const open = columns.find((column) => column.status === 'open')!
  assert.deepEqual(open.cards.map(ticketCardKey), ['files:board', 'github:145'])
})

test('only a source that can write its status accepts a drop', () => {
  const writable = {
    id: 'files',
    label: 'Files',
    list: async () => listing([]),
    setStatus: async () => ({ ok: true as const, card: card({ id: 'a' }) })
  }
  const readOnly = { id: 'github', label: 'GitHub', list: async () => listing([]) }
  const sources = [writable, readOnly]
  assert.equal(ticketDropAllowed(card({ id: 'a', sourceId: 'files' }), sources), true)
  assert.equal(ticketDropAllowed(card({ id: 'a', sourceId: 'github' }), sources), false)
  assert.equal(ticketDropAllowed(card({ id: 'a', sourceId: 'jira' }), sources), false)
})

test('blockers report whether the ticket they name is done, still pending, or absent', () => {
  const cards = [
    card({ id: 'blocked-one', status: 'blocked', blockedBy: ['finished', 'pending', 'ghost'] }),
    card({ id: 'finished', status: 'done' }),
    card({ id: 'pending', status: 'in-progress' })
  ]
  assert.deepEqual(ticketBlockers(cards[0], cards), [
    { id: 'finished', state: 'done' },
    { id: 'pending', state: 'pending' },
    { id: 'ghost', state: 'missing' }
  ])
  assert.deepEqual(ticketBlockers(card({ id: 'free' }), cards), [])
})

test('a blocker only resolves against its own source', () => {
  const cards = [
    card({ id: 'a', sourceId: 'files', blockedBy: ['shared-slug'] }),
    card({ id: 'shared-slug', sourceId: 'github', status: 'done' })
  ]
  assert.deepEqual(ticketBlockers(cards[0], cards), [{ id: 'shared-slug', state: 'missing' }])
})

test('an unknown status is titled from its own words', () => {
  assert.equal(ticketStatusLabel('in-progress'), 'In progress')
  assert.equal(ticketStatusLabel('needs-review'), 'Needs review')
})

test('a card date reads as a calendar day, relative only while it is recent', () => {
  assert.equal(describeTicketDate(TODAY, TODAY), 'today')
  assert.equal(describeTicketDate('2026-09-03', TODAY), 'yesterday')
  assert.equal(describeTicketDate('2026-09-01', TODAY), '3 days ago')
  assert.equal(describeTicketDate('2026-07-01', TODAY), '2026-07-01')
})

test('a keyboard move steps one column and stops at either end of the board', () => {
  const columns = ticketBoardColumns({ listings: [listing([])], today: TODAY, showAllDone: false })
  assert.equal(ticketStatusBeside(columns, 'open', 1), 'in-progress')
  assert.equal(ticketStatusBeside(columns, 'in-progress', -1), 'open')
  assert.equal(ticketStatusBeside(columns, 'open', -1), undefined)
  assert.equal(ticketStatusBeside(columns, 'done', 1), undefined)
  assert.equal(ticketStatusBeside(columns, 'invented', 1), undefined)
})

test('the bulk delete offers exactly the Done cards the collapsed column already folded away', () => {
  const cards = [
    card({ id: 'closed-long-ago', status: 'done', updated: '2026-06-01' }),
    card({ id: 'closed-on-the-cutoff', status: 'done', updated: '2026-08-05' }),
    card({ id: 'closed-a-day-past', status: 'done', updated: '2026-08-04' }),
    card({ id: 'closed-today', status: 'done', updated: TODAY }),
    card({ id: 'still-open', status: 'open', updated: '2026-01-01' }),
    card({ id: 'undated', status: 'done', updated: 'not-a-date' })
  ]
  assert.deepEqual(
    staleDoneCards(cards, TODAY).map((entry) => entry.id),
    ['closed-a-day-past', 'closed-long-ago']
  )
  // The same cutoff either way: what the bulk delete offers is what the column is not showing.
  const done = ticketBoardColumns({ listings: [listing(cards)], today: TODAY, showAllDone: false }).find(
    (entry) => entry.status === 'done'
  )!
  assert.equal(done.hidden, staleDoneCards(cards, TODAY).length)
  assert.equal(DONE_COLUMN_RECENT_DAYS, 30)
})

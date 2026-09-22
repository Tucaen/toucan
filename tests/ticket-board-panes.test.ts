import { strict as assert } from 'node:assert'
import { test } from 'vitest'
import type { TicketBoardColumn } from '../src/renderer/src/ticket-board'
import {
  TICKET_DETAIL_DEFAULT_WIDTH,
  TICKET_DETAIL_MIN_WIDTH,
  TICKET_LIST_MIN_WIDTH,
  TICKET_PANES_CHROME_WIDTH,
  TICKET_STATE_PANE_WIDTH,
  clampTicketDetailWidth,
  resolveTicketPanes,
  ticketArrowStep,
  ticketDetailWidthFromPointer,
  ticketIndexBeside,
  ticketPaneBeside,
  ticketPaneMode,
  visibleTicketPanes
} from '../src/renderer/src/ticket-board-panes'
import type { TicketCard } from '../src/shared/ticket-source'

/**
 * The three-pane board's arithmetic without a DOM: which state and which ticket a re-read leaves
 * selected, how much of the panel the detail may take, and which pane a Left/Right press reaches.
 */

function card(overrides: Partial<TicketCard> = {}): TicketCard {
  return {
    sourceId: 'files',
    id: 'file-node',
    title: 'File node',
    status: 'open',
    updated: '2026-09-04',
    ...overrides
  }
}

function columns(...entries: { status: string; cards?: TicketCard[]; hidden?: number }[]): TicketBoardColumn[] {
  return entries.map((entry) => ({
    status: entry.status,
    label: entry.status,
    cards: entry.cards ?? [],
    hidden: entry.hidden ?? 0
  }))
}

test('an empty board selects nothing', () => {
  assert.deepEqual(resolveTicketPanes({ columns: [], cards: [], selection: { status: null, cardKey: null } }), {
    status: null,
    cardKey: null
  })
})

test('a first read opens the first state that actually has tickets', () => {
  const board = columns({ status: 'open' }, { status: 'in-progress', cards: [card({ status: 'in-progress' })] })
  const resolved = resolveTicketPanes({ columns: board, cards: [], selection: { status: null, cardKey: null } })
  assert.equal(resolved.status, 'in-progress')
})

test('a board with nothing on it still selects a state, so there is a drop target to see', () => {
  const board = columns({ status: 'open' }, { status: 'done' })
  const resolved = resolveTicketPanes({ columns: board, cards: [], selection: { status: null, cardKey: null } })
  assert.equal(resolved.status, 'open')
})

test('a state whose tickets a collapsed cutoff is withholding still counts as the busy one', () => {
  const board = columns({ status: 'open' }, { status: 'done', hidden: 3 })
  const resolved = resolveTicketPanes({ columns: board, cards: [], selection: { status: null, cardKey: null } })
  assert.equal(resolved.status, 'done')
})

test('a chosen state is kept even once it is empty', () => {
  const board = columns({ status: 'open', cards: [card()] }, { status: 'blocked' })
  const resolved = resolveTicketPanes({
    columns: board,
    cards: [card()],
    selection: { status: 'blocked', cardKey: null }
  })
  assert.equal(resolved.status, 'blocked')
})

test('a state a project stopped using falls back rather than showing an empty pane forever', () => {
  const board = columns({ status: 'open', cards: [card()] })
  const resolved = resolveTicketPanes({
    columns: board,
    cards: [card()],
    selection: { status: 'review', cardKey: null }
  })
  assert.equal(resolved.status, 'open')
})

test('the selected ticket survives a status move, and the state follows it', () => {
  const moved = card({ status: 'done' })
  const board = columns({ status: 'open' }, { status: 'done', cards: [moved] })
  assert.deepEqual(
    resolveTicketPanes({ columns: board, cards: [moved], selection: { status: 'open', cardKey: 'files:file-node' } }),
    { status: 'done', cardKey: 'files:file-node' }
  )
})

test('a ticket that is no longer listed clears the detail instead of holding a ghost open', () => {
  const board = columns({ status: 'open' })
  assert.deepEqual(
    resolveTicketPanes({ columns: board, cards: [], selection: { status: 'open', cardKey: 'files:file-node' } }),
    { status: 'open', cardKey: null }
  )
})

test('a wide panel holds states, list and detail side by side', () => {
  assert.equal(ticketPaneMode(880), 'three')
})

test('a panel too narrow for all three collapses to two', () => {
  assert.equal(ticketPaneMode(520), 'two')
})

test('the detail never eats the list, chrome included', () => {
  // The list keeps its own floor even when the drag asks for everything.
  assert.equal(
    clampTicketDetailWidth(5000, 880),
    880 - TICKET_STATE_PANE_WIDTH - TICKET_LIST_MIN_WIDTH - TICKET_PANES_CHROME_WIDTH
  )
  assert.equal(clampTicketDetailWidth(10, 880), TICKET_DETAIL_MIN_WIDTH)
})

test('a board that has never been resized falls back to the comfortable default', () => {
  assert.equal(clampTicketDetailWidth(undefined, 1200), TICKET_DETAIL_DEFAULT_WIDTH)
  assert.equal(clampTicketDetailWidth(Number.NaN, 1200), TICKET_DETAIL_DEFAULT_WIDTH)
})

test('the divider is dragged from the right, so the detail is whatever is left of the panel edge', () => {
  assert.equal(ticketDetailWidthFromPointer(700, 1100, 1000), 400)
})

test('three panes are offered only once a ticket is open', () => {
  assert.deepEqual(visibleTicketPanes('three', false), ['states', 'list'])
  assert.deepEqual(visibleTicketPanes('three', true), ['states', 'list', 'detail'])
})

test('a narrow board swaps the list for the detail rather than squeezing both', () => {
  assert.deepEqual(visibleTicketPanes('two', false), ['states', 'list'])
  assert.deepEqual(visibleTicketPanes('two', true), ['states', 'detail'])
})

test('Left and Right step between the panes that are actually there, and stop at the ends', () => {
  const visible = visibleTicketPanes('three', true)
  assert.equal(ticketPaneBeside(visible, 'states', 1), 'list')
  assert.equal(ticketPaneBeside(visible, 'list', 1), 'detail')
  assert.equal(ticketPaneBeside(visible, 'detail', 1), undefined)
  assert.equal(ticketPaneBeside(visible, 'states', -1), undefined)
})

test('an arrow key means one axis and one direction, and nothing else does', () => {
  assert.deepEqual(ticketArrowStep('ArrowLeft'), { axis: 'horizontal', delta: -1 })
  assert.deepEqual(ticketArrowStep('ArrowDown'), { axis: 'vertical', delta: 1 })
  assert.equal(ticketArrowStep('Enter'), undefined)
})

test('Up and Down stay inside a list rather than wrapping around it', () => {
  assert.equal(ticketIndexBeside(3, 0, 1), 1)
  assert.equal(ticketIndexBeside(3, 2, 1), 2)
  assert.equal(ticketIndexBeside(3, 0, -1), 0)
  assert.equal(ticketIndexBeside(0, -1, 1), -1)
})

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  TICKET_BOARD_DEFAULT_WIDTH,
  TICKET_BOARD_MAX_WIDTH,
  TICKET_BOARD_MIN_WIDTH,
  clampTicketBoardWidth,
  ticketBoardBounds,
  ticketBoardKeyAction,
  ticketBoardWidthFromPointer
} from '../src/renderer/src/ticket-board-layout'

const key = (
  overrides: Partial<Parameters<typeof ticketBoardKeyAction>[0]>
): Parameters<typeof ticketBoardKeyAction>[0] => ({
  key: 'k',
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  metaKey: false,
  ...overrides
})

test('the board never takes more than its share of a narrow workspace', () => {
  assert.deepEqual(ticketBoardBounds(2560), { min: TICKET_BOARD_MIN_WIDTH, max: TICKET_BOARD_MAX_WIDTH })
  assert.deepEqual(ticketBoardBounds(1000), { min: TICKET_BOARD_MIN_WIDTH, max: 700 })
  // Too small to honour both bounds: the floor wins, so the board stays usable.
  assert.deepEqual(ticketBoardBounds(400), { min: TICKET_BOARD_MIN_WIDTH, max: TICKET_BOARD_MIN_WIDTH })
})

test('a width from a wider monitor is folded into the current window', () => {
  assert.equal(clampTicketBoardWidth(TICKET_BOARD_MAX_WIDTH, 1000), 700)
  assert.equal(clampTicketBoardWidth(120, 1920), TICKET_BOARD_MIN_WIDTH)
  assert.equal(clampTicketBoardWidth(Number.NaN, 1920), TICKET_BOARD_DEFAULT_WIDTH)
})

test('a left-edge drag sets the width remaining to the docked edge', () => {
  assert.equal(ticketBoardWidthFromPointer(1120, 1920, 1920), 800)
})

test('Ctrl+Shift+K toggles the board and nothing else does', () => {
  assert.equal(ticketBoardKeyAction(key({ ctrlKey: true, shiftKey: true })), 'toggle-panel')
  assert.equal(ticketBoardKeyAction(key({ ctrlKey: true, shiftKey: true, key: 'K' })), 'toggle-panel')
  assert.equal(ticketBoardKeyAction(key({ ctrlKey: true })), 'none')
  assert.equal(ticketBoardKeyAction(key({ ctrlKey: true, shiftKey: true, altKey: true })), 'none')
  assert.equal(ticketBoardKeyAction(key({ ctrlKey: true, shiftKey: true, key: 'b' })), 'none')
})

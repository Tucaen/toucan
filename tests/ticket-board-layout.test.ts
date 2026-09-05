import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  TICKET_BOARD_DEFAULT_WIDTH,
  TICKET_BOARD_MAX_WIDTH,
  TICKET_BOARD_MIN_WIDTH,
  clampTicketBoardWidth,
  pruneEnabledSources,
  ticketBoardBounds,
  ticketBoardKeyAction,
  ticketBoardWidthFromPointer,
  withEnabledSource
} from '../src/renderer/src/ticket-board-layout'

test('a source is switched on and off for one project without touching the others', () => {
  const on = withEnabledSource(undefined, 'D:\\a', 'github', true)
  assert.deepEqual(on, { 'D:\\a': ['github'] })
  // Switching on twice does not list it twice; switching off leaves the other project's choice.
  assert.deepEqual(withEnabledSource(on, 'D:\\a', 'github', true), { 'D:\\a': ['github'] })
  const both = withEnabledSource(on, 'D:\\b', 'github', true)
  assert.deepEqual(withEnabledSource(both, 'D:\\a', 'github', false), { 'D:\\a': [], 'D:\\b': ['github'] })
})

test('choices for projects that no longer exist are dropped on restore', () => {
  assert.deepEqual(pruneEnabledSources({ 'D:\\a': ['github'], 'D:\\gone': ['github'] }, ['D:\\a']), {
    'D:\\a': ['github']
  })
  assert.deepEqual(pruneEnabledSources(undefined, ['D:\\a']), {})
})

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

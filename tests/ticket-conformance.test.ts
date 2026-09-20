import { deepEqual, equal, match, ok } from 'node:assert/strict'
import { test } from 'node:test'
import type { AgentFileWrite } from '../src/shared/agent-activity'
import { RECENT_WRITE_WINDOW_MS, reportedTicketKey, ticketConformanceSteers } from '../src/shared/ticket-conformance'
import type { TicketDiagnostic } from '../src/shared/tickets'

/**
 * Who gets told that a file in the tickets folder is not a ticket. The board already shows the
 * diagnostic row; this decides whether an agent session also hears about the file it just wrote,
 * and it must never tell a session about someone else's file or the same breakage twice.
 */

const broken = (path: string, message = 'Filename must be a lowercase kebab-case slug.'): TicketDiagnostic => ({
  path,
  code: 'unusable-filename',
  message
})

const wrote = (agentId: string, path: string, at: number): AgentFileWrite => ({ agentId, path, at })

/** Every write below is stamped well inside the evidence window; staleness has its own test. */
const NOW = 1000
const BOARD = 'D:/checkout/docs/tickets/To Tickets.md'

test('the one session that wrote the unshowable file is steered, named with the reason', () => {
  const decision = ticketConformanceSteers({
    diagnostics: [broken(BOARD, 'Filename must be a lowercase kebab-case slug.')],
    writes: [wrote('node-1', BOARD, 10)],
    reported: new Map(),
    now: NOW
  })

  equal(decision.steers.length, 1)
  equal(decision.steers[0].agentId, 'node-1')
  deepEqual(decision.steers[0].files, [broken(BOARD, 'Filename must be a lowercase kebab-case slug.')])
  ok(decision.steers[0].text.includes(BOARD))
  ok(decision.steers[0].text.includes('Filename must be a lowercase kebab-case slug.'))
  match(decision.steers[0].text, /tickets` skill/)
})

test('a file nobody is recorded as having written steers no session and is not remembered', () => {
  const decision = ticketConformanceSteers({
    diagnostics: [broken(BOARD)],
    writes: [wrote('node-1', 'D:/checkout/src/main/index.ts', 10)],
    reported: new Map(),
    now: NOW
  })

  deepEqual(decision.steers, [])
  // Deliberately not remembered: an agent that later writes the same still-broken file must
  // still hear about it, which a recorded hand-edit would suppress.
  equal(decision.reported.size, 0)
})

test('with two writers only the most recent one is steered', () => {
  const decision = ticketConformanceSteers({
    diagnostics: [broken(BOARD)],
    writes: [wrote('node-1', BOARD, 10), wrote('node-2', BOARD, 40), wrote('node-1', BOARD, 20)],
    reported: new Map(),
    now: NOW
  })

  equal(decision.steers.length, 1)
  equal(decision.steers[0].agentId, 'node-2')
})

test('a path is matched by identity, not string equality', () => {
  const decision = ticketConformanceSteers({
    diagnostics: [broken('D:\\checkout\\docs\\tickets\\To Tickets.md')],
    writes: [wrote('node-1', 'd:/checkout/docs/tickets/To Tickets.md', 10)],
    reported: new Map(),
    now: NOW
  })

  equal(decision.steers[0]?.agentId, 'node-1')
})

test('a file that stays broken with the same error is not steered again', () => {
  const reported = new Map([[reportedTicketKey('node-1', BOARD), 'Filename must be a lowercase kebab-case slug.']])
  const decision = ticketConformanceSteers({
    diagnostics: [broken(BOARD, 'Filename must be a lowercase kebab-case slug.')],
    writes: [wrote('node-1', BOARD, 10)],
    reported,
    now: NOW
  })

  deepEqual(decision.steers, [])
  // Still broken, so still remembered: the next watcher tick must dedupe against it too.
  deepEqual([...decision.reported], [...reported])
})

test('a still-broken file whose error changed is steered again', () => {
  const decision = ticketConformanceSteers({
    diagnostics: [broken(BOARD, 'created must use YYYY-MM-DD.')],
    writes: [wrote('node-1', BOARD, 10)],
    reported: new Map([[reportedTicketKey('node-1', BOARD), 'Filename must be a lowercase kebab-case slug.']]),
    now: NOW
  })

  equal(decision.steers.length, 1)
  deepEqual(decision.steers[0].files, [broken(BOARD, 'created must use YYYY-MM-DD.')])
  // The new error replaces the old one only once it has actually been delivered.
  deepEqual([...decision.reported], [])
})

test('a fixed or deleted file is forgotten, so breaking it again steers anew', () => {
  const decision = ticketConformanceSteers({
    diagnostics: [],
    writes: [wrote('node-1', BOARD, 10)],
    reported: new Map([[reportedTicketKey('node-1', BOARD), 'Filename must be a lowercase kebab-case slug.']]),
    now: NOW
  })

  deepEqual(decision.steers, [])
  equal(decision.reported.size, 0)

  const again = ticketConformanceSteers({
    diagnostics: [broken(BOARD)],
    writes: [wrote('node-1', BOARD, 10)],
    reported: decision.reported,
    now: NOW
  })
  equal(again.steers.length, 1)
})

test('several files one session broke arrive as one steer, not one prompt each', () => {
  const other = 'D:/checkout/docs/tickets/notes.md'
  const decision = ticketConformanceSteers({
    diagnostics: [broken(BOARD), broken(other, 'title is required.')],
    writes: [wrote('node-1', BOARD, 10), wrote('node-1', other, 20)],
    reported: new Map(),
    now: NOW
  })

  equal(decision.steers.length, 1)
  equal(decision.steers[0].agentId, 'node-1')
  equal(decision.steers[0].files.length, 2)
  ok(decision.steers[0].text.includes(BOARD))
  ok(decision.steers[0].text.includes(other))
})

test('files broken by different sessions are steered separately', () => {
  const other = 'D:/checkout/docs/tickets/notes.md'
  const decision = ticketConformanceSteers({
    diagnostics: [broken(BOARD), broken(other)],
    writes: [wrote('node-1', BOARD, 10), wrote('node-2', other, 20)],
    reported: new Map(),
    now: NOW
  })

  deepEqual(
    decision.steers.map((steer) => steer.agentId),
    ['node-1', 'node-2']
  )
})

test('a write too old to be evidence steers nobody, so a hand edit stays the board’s business', () => {
  const decision = ticketConformanceSteers({
    diagnostics: [broken(BOARD)],
    writes: [wrote('node-1', BOARD, 10)],
    reported: new Map(),
    // The session wrote this file once, long ago, and has moved on; somebody else broke it since.
    now: 10 + RECENT_WRITE_WINDOW_MS + 1
  })

  deepEqual(decision.steers, [])
})

test('a second session that rewrites a file the first was told about hears about it too', () => {
  const reported = new Map([[reportedTicketKey('node-1', BOARD), 'Filename must be a lowercase kebab-case slug.']])
  const decision = ticketConformanceSteers({
    diagnostics: [broken(BOARD)],
    writes: [wrote('node-1', BOARD, 10), wrote('node-2', BOARD, 20)],
    reported,
    now: NOW
  })

  // Dedupe is per session: node-2 produced this broken file just as node-1 did, and telling only
  // the session that happened to get there first would leave the actual author uncorrected.
  equal(decision.steers.length, 1)
  equal(decision.steers[0].agentId, 'node-2')
  // node-1 is no longer the writer, so its record is dropped rather than carried forever.
  equal(decision.reported.size, 0)
})

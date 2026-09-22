import { deepEqual, equal, ok } from 'node:assert/strict'
import { test } from 'vitest'
import { createTicketSteering } from '../src/main/ticket-steering'
import type { AgentFileWrite } from '../src/shared/agent-activity'
import type { TicketDiagnostic } from '../src/shared/tickets'

/**
 * The delivery half: a watcher tick re-lists the project, asks who wrote what, and sends at most
 * one corrective message per session. The decision itself is `tests/ticket-conformance.test.ts`;
 * what is proved here is that the dedupe survives across ticks, that a failed delivery is retried,
 * and that a project that cannot be listed costs nothing.
 */

/**
 * A check hands its messages off rather than waiting for them: a queued one is not delivered until
 * the turn in flight ends. This is how a test observes the outcome of a delivery that already
 * resolved.
 */
const settled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

const BOARD = 'D:/checkout/docs/tickets/To Tickets.md'
const broken = (message = 'Filename must be a lowercase kebab-case slug.'): TicketDiagnostic => ({
  path: BOARD,
  code: 'unusable-filename',
  message
})

interface Harness {
  diagnostics: TicketDiagnostic[]
  writes: AgentFileWrite[]
  delivered: Array<{ agentId: string; text: string }>
  deliver: { ok: boolean; message?: string }
  listFailure?: Error
}

function harness(): { state: Harness; steering: ReturnType<typeof createTicketSteering> } {
  const state: Harness = {
    diagnostics: [],
    writes: [{ agentId: 'node-1', path: BOARD, at: Date.now() }],
    delivered: [],
    deliver: { ok: true }
  }
  const steering = createTicketSteering({
    diagnosticsFor: async () => {
      if (state.listFailure) throw state.listFailure
      return state.diagnostics
    },
    recentWrites: () => state.writes,
    steer: async (agentId, text) => {
      state.delivered.push({ agentId, text })
      return state.deliver
    }
  })
  return { state, steering }
}

test('an unshowable file is reported to its writer once, however often the folder changes', async () => {
  const { state, steering } = harness()
  state.diagnostics = [broken()]

  await steering.check('D:/checkout')
  await steering.check('D:/checkout')

  equal(state.delivered.length, 1)
  equal(state.delivered[0].agentId, 'node-1')
  ok(state.delivered[0].text.includes(BOARD))
})

test('fixing then re-breaking the same file produces a second message', async () => {
  const { state, steering } = harness()
  state.diagnostics = [broken()]
  await steering.check('D:/checkout')

  state.diagnostics = []
  await steering.check('D:/checkout')

  state.diagnostics = [broken()]
  await steering.check('D:/checkout')

  equal(state.delivered.length, 2)
})

test('a message the session could not accept is retried on the next change', async () => {
  const { state, steering } = harness()
  state.diagnostics = [broken()]
  state.deliver = { ok: false, message: 'This agent session is not running.' }
  await steering.check('D:/checkout')
  await settled()

  state.deliver = { ok: true }
  await steering.check('D:/checkout')
  await settled()
  await steering.check('D:/checkout')

  // Refused, delivered, then deduped - never a message silently swallowed by a dead session.
  equal(state.delivered.length, 2)
})

test('dedupe is per project, so two checkouts cannot suppress each other', async () => {
  const { state, steering } = harness()
  state.diagnostics = [broken()]

  await steering.check('D:/checkout')
  await steering.check('D:/other')

  deepEqual(
    state.delivered.map((message) => message.agentId),
    ['node-1', 'node-1']
  )
})

test('a project whose tickets folder cannot be listed steers nobody and does not throw', async () => {
  const { state, steering } = harness()
  state.diagnostics = [broken()]
  state.listFailure = new Error('EPERM')

  await steering.check('D:/checkout')

  deepEqual(state.delivered, [])
})

test('a delivery that throws is logged rather than left as an unhandled rejection', async () => {
  const logged: string[] = []
  const steering = createTicketSteering({
    diagnosticsFor: async () => [broken()],
    recentWrites: () => [{ agentId: 'node-1', path: BOARD, at: Date.now() }],
    steer: () => Promise.reject(new Error('adapter gone')),
    log: (message) => logged.push(message)
  })

  await steering.check('D:/checkout')
  await settled()

  equal(logged.length, 1)
  ok(logged[0].includes('adapter gone'))
})

test('a message still waiting behind a working turn is not sent a second time', async () => {
  const delivered: string[] = []
  const steering = createTicketSteering({
    diagnosticsFor: async () => [broken()],
    recentWrites: () => [{ agentId: 'node-1', path: BOARD, at: Date.now() }],
    // Queued behind a turn in flight: this is what `promptWhenIdle` does for an adapter that
    // cannot steer, and it may not settle for minutes.
    steer: (agentId) => {
      delivered.push(agentId)
      return new Promise(() => {})
    }
  })

  await steering.check('D:/checkout')
  await steering.check('D:/checkout')
  await settled()

  deepEqual(delivered, ['node-1'])
})

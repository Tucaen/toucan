import { strict as assert } from 'node:assert'
import { test } from 'vitest'
import { createTicketSessionRequests, TICKET_SESSION_TIMEOUT_MESSAGE } from '../src/main/ticket-session-requests'
import type { DesktopWindow } from '../src/main/window-requests'
import { ORCHESTRATOR_CHANNELS } from '../src/shared/ipc-channels'
import type { TicketSessionCanvasRequest } from '../src/shared/ticket-session-spawn'

/**
 * Issue #1: a ticket session that outlasts `spawn`'s wait is not a failure. The orchestrator is told
 * `pending` with the session the canvas reported, the session stays open, and what it settles to
 * later is handed to whoever asked - instead of being closed behind the orchestrator's back.
 */

const request: TicketSessionCanvasRequest = {
  provider: 'claude',
  projectId: 'project',
  worktree: { path: 'D:/project-worktrees/ticket-14', branch: 'ticket/14', baseRef: 'master' },
  label: '#14 Power Shot',
  modelId: 'sonnet',
  effortId: 'medium',
  orchestratedBy: { nodeId: 'captain', conversationId: 'captain-conversation', provider: 'claude' },
  prompt: '/implement #14'
}

function fakeWindow(): DesktopWindow & { sent: { channel: string; args: unknown[] }[]; destroy(): void } {
  let destroyed = false
  const sent: { channel: string; args: unknown[] }[] = []
  return {
    sent,
    destroy: () => {
      destroyed = true
    },
    isDestroyed: () => destroyed,
    send: (channel, ...args) => sent.push({ channel, args })
  }
}

function manualClock(): {
  schedule: (run: () => void, delayMs: number) => { cancel(): void }
  fire(): void
  delays: number[]
} {
  let pending: (() => void) | null = null
  const delays: number[] = []
  return {
    delays,
    schedule: (run, delayMs) => {
      pending = run
      delays.push(delayMs)
      return {
        cancel: () => {
          if (pending === run) pending = null
        }
      }
    },
    fire: () => {
      const run = pending
      pending = null
      run?.()
    }
  }
}

const ticketSession = { nodeId: 'ticket', conversationId: 'ticket-conversation' }

test('a session that misses the wait is answered pending with its node, and is not withdrawn', async () => {
  const clock = manualClock()
  const requests = createTicketSessionRequests({ requestId: () => 'req-1', schedule: clock.schedule })
  const window = fakeWindow()
  requests.attach(window)
  const late: unknown[] = []

  const answer = requests.request(request, { late: (result) => late.push(result) })
  requests.progress('req-1', { nodeId: 'ticket' })
  clock.fire()

  assert.deepEqual(await answer, {
    ok: false,
    pending: true,
    message: TICKET_SESSION_TIMEOUT_MESSAGE,
    nodeId: 'ticket'
  })
  // Nothing is sent to close it: it keeps starting.
  assert.deepEqual(
    window.sent.map((message) => message.channel),
    [ORCHESTRATOR_CHANNELS.startTicketSession]
  )
  assert.deepEqual(late, [])

  // It comes up after all: that is news for whoever asked.
  requests.complete('req-1', { ok: true, ...ticketSession })
  assert.deepEqual(late, [{ ok: true, ...ticketSession }])
})

test('a pending session that then fails reports the failure to whoever asked', async () => {
  const clock = manualClock()
  const requests = createTicketSessionRequests({ requestId: () => 'req-1', schedule: clock.schedule })
  requests.attach(fakeWindow())
  const late: unknown[] = []

  const answer = requests.request(request, { late: (result) => late.push(result) })
  requests.progress('req-1', { nodeId: 'ticket' })
  clock.fire()
  await answer
  requests.complete('req-1', { ok: false, message: 'The ticket session could not be started on the desktop.' })

  assert.deepEqual(late, [{ ok: false, message: 'The ticket session could not be started on the desktop.' }])
})

test('a pending session whose window closes reports that, not silence', async () => {
  const clock = manualClock()
  const requests = createTicketSessionRequests({ requestId: () => 'req-1', schedule: clock.schedule })
  const detach = requests.attach(fakeWindow())
  const late: unknown[] = []

  const answer = requests.request(request, { late: (result) => late.push(result) })
  requests.progress('req-1', { nodeId: 'ticket' })
  clock.fire()
  await answer
  detach()

  assert.deepEqual(late, [{ ok: false, message: 'The Toucan window closed before the ticket session was started.' }])
})

test('the wait restarts on every sign of life, and a project can set how long it is', async () => {
  const clock = manualClock()
  const requests = createTicketSessionRequests({ requestId: () => 'req-1', schedule: clock.schedule })
  requests.attach(fakeWindow())

  const answer = requests.request(request, { timeoutMs: 600_000 })
  requests.progress('req-1', { nodeId: 'ticket' })
  // The session prints something while starting (adapter progress, a first message).
  requests.activity('ticket')
  assert.deepEqual(clock.delays, [600_000, 600_000, 600_000])

  clock.fire()
  assert.equal(((await answer) as { pending?: boolean }).pending, true)
})

test('an unconfigured wait is longer than the 90 seconds that kept timing out slow setups', () => {
  const clock = manualClock()
  const requests = createTicketSessionRequests({ requestId: () => 'req-1', schedule: clock.schedule })
  requests.attach(fakeWindow())
  void requests.request(request)
  assert.ok(clock.delays[0] > 90_000)
})

test('a node main cancels is closed by its node id, on the window that is open now', () => {
  const requests = createTicketSessionRequests()
  const window = fakeWindow()
  requests.attach(window)
  requests.cancel('ticket')
  assert.deepEqual(window.sent, [{ channel: ORCHESTRATOR_CHANNELS.cancelTicketSession, args: ['ticket'] }])
})

test('a session that settles in time is answered, never pending, and not reported late', async () => {
  const clock = manualClock()
  const requests = createTicketSessionRequests({ requestId: () => 'req-1', schedule: clock.schedule })
  const window = fakeWindow()
  requests.attach(window)
  const late: unknown[] = []

  const answer = requests.request(request, { late: (result) => late.push(result) })
  requests.complete('req-1', { ok: true, ...ticketSession })
  clock.fire()

  assert.deepEqual(await answer, { ok: true, ...ticketSession })
  assert.deepEqual(late, [])
  assert.deepEqual(
    window.sent.map((message) => message.channel),
    [ORCHESTRATOR_CHANNELS.startTicketSession]
  )
})

test('there is no window to ask, or it closes first: a refusal, not a pending session', async () => {
  const none = createTicketSessionRequests()
  assert.equal(((await none.request(request)) as { ok: boolean }).ok, false)

  const requests = createTicketSessionRequests({ requestId: () => 'req-1' })
  const detach = requests.attach(fakeWindow())
  const answer = requests.request(request)
  detach()
  assert.deepEqual(await answer, {
    ok: false,
    message: 'The Toucan window closed before the ticket session was started.'
  })
})

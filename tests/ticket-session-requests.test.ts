import { strict as assert } from 'node:assert'
import { test } from 'vitest'
import { createTicketSessionRequests, TICKET_SESSION_TIMEOUT_MESSAGE } from '../src/main/ticket-session-requests'
import type { DesktopWindow } from '../src/main/window-requests'
import { ORCHESTRATOR_CHANNELS } from '../src/shared/ipc-channels'
import type { TicketSessionCanvasRequest } from '../src/shared/ticket-session-spawn'

/**
 * Issue #1: `spawn` reported a ticket session as failed after the canvas timeout, yet the session
 * came up minutes later, took the ticket prompt and did the work, unseen by its orchestrator. A
 * timeout is a verdict the orchestrator acts on - it retries - so it has to be made true: the
 * window that was asked is told to withdraw the session, and nothing it says afterwards counts.
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

function manualClock(): { schedule: (run: () => void, delayMs: number) => { cancel(): void }; fire(): void } {
  let pending: (() => void) | null = null
  return {
    schedule: (run) => {
      pending = run
      return {
        cancel: () => {
          pending = null
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

test('a session that misses the timeout is withdrawn, and its late start is not news', async () => {
  const clock = manualClock()
  const requests = createTicketSessionRequests({ requestId: () => 'req-1', schedule: clock.schedule })
  const window = fakeWindow()
  requests.attach(window)

  const pending = requests.request(request)
  clock.fire()

  assert.deepEqual(await pending, { ok: false, message: TICKET_SESSION_TIMEOUT_MESSAGE })
  assert.deepEqual(window.sent, [
    { channel: ORCHESTRATOR_CHANNELS.startTicketSession, args: ['req-1', request] },
    { channel: ORCHESTRATOR_CHANNELS.cancelTicketSession, args: ['req-1'] }
  ])
  // The session comes up after all: the spawn has been answered and stays answered.
  requests.complete('req-1', { ok: true, nodeId: 'ticket', conversationId: 'ticket-conversation' })
  assert.equal(window.sent.length, 2)
})

test('the timeout message says the session was closed rather than that it may still appear', () => {
  assert.doesNotMatch(TICKET_SESSION_TIMEOUT_MESSAGE, /may still appear/)
  assert.match(TICKET_SESSION_TIMEOUT_MESSAGE, /closes it/)
})

test('a session that settles in time is never withdrawn', async () => {
  const clock = manualClock()
  const requests = createTicketSessionRequests({ requestId: () => 'req-1', schedule: clock.schedule })
  const window = fakeWindow()
  requests.attach(window)

  const pending = requests.request(request)
  requests.complete('req-1', { ok: true, nodeId: 'ticket', conversationId: 'ticket-conversation' })
  clock.fire()

  assert.deepEqual(await pending, { ok: true, nodeId: 'ticket', conversationId: 'ticket-conversation' })
  assert.deepEqual(
    window.sent.map((message) => message.channel),
    [ORCHESTRATOR_CHANNELS.startTicketSession]
  )
})

test('a window destroyed before the timeout is not written to', async () => {
  const clock = manualClock()
  const requests = createTicketSessionRequests({ requestId: () => 'req-1', schedule: clock.schedule })
  const window = fakeWindow()
  requests.attach(window)

  const pending = requests.request(request)
  window.destroy()
  clock.fire()

  assert.deepEqual(await pending, { ok: false, message: TICKET_SESSION_TIMEOUT_MESSAGE })
  assert.deepEqual(
    window.sent.map((message) => message.channel),
    [ORCHESTRATOR_CHANNELS.startTicketSession]
  )
})

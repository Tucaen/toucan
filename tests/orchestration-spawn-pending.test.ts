import { strict as assert } from 'node:assert'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'
import { createOrchestrationStore } from '../src/main/orchestration-store'
import { createOrchestrationWaker } from '../src/main/orchestration-wake'
import { createOrchestratorEndpoint, type OrchestratorGrant } from '../src/main/orchestrator-endpoint'
import { createTicketSpawner } from '../src/main/ticket-spawner'
import { createTicketSessionRequests } from '../src/main/ticket-session-requests'
import type { DesktopWindow } from '../src/main/window-requests'
import type { AgentEvent } from '../src/shared/agent'
import { ORCHESTRATOR_CHANNELS } from '../src/shared/ipc-channels'
import {
  ORCHESTRATOR_TOKEN_ENV,
  ORCHESTRATOR_URL_ENV,
  type OrchestrationRecord,
  type OrchestrationTicket
} from '../src/shared/orchestration'
import type { TicketSessionCanvasRequest } from '../src/shared/ticket-session-spawn'

/**
 * Issue #1, end to end through the real parts: an orchestrator's `spawn` whose ticket session is
 * slow to come up. The wait running out is not a failure - the ticket keeps its session link,
 * `status` shows it starting and then working, and the orchestrator is woken when the session
 * settles, however long after `spawn` answered. A start Toucan does treat as failed is stopped.
 */

const NODE = 'ticket-node'
const CONVERSATION = 'ticket-conversation'

function harness() {
  const records = createOrchestrationStore({ directory: mkdtempSync(join(tmpdir(), 'toucan-spawn-pending-')) })

  // The wait runs out when the test says so.
  let expire: (() => void) | null = null
  let requestCount = 0
  const requests = createTicketSessionRequests({
    requestId: () => `request-${++requestCount}`,
    schedule: (run) => {
      expire = run
      return {
        cancel: () => {
          if (expire === run) expire = null
        }
      }
    }
  })
  const sent: { channel: string; args: unknown[] }[] = []
  requests.attach({
    isDestroyed: () => false,
    send: (channel, ...args) => sent.push({ channel, args })
  } satisfies DesktopWindow)

  // What the broker's snapshot would say of each session.
  const live = new Map<string, { status: string }>()
  const cancelled: string[] = []
  const stopped: string[] = []
  const killed: Array<{ nodeId: string; starting: boolean }> = []

  const delivered: string[] = []
  const timers: Array<() => void> = []
  const waker = createOrchestrationWaker({
    deliver: async (_node, text) => {
      delivered.push(text)
      return { ok: true }
    },
    resolve: async () => null,
    outcome: async () => undefined,
    schedule: (callback) => {
      timers.push(callback)
      return () => undefined
    }
  })
  /**
   * What the orchestrator was woken with: waits for the first wake to be queued (they are folded
   * over a window and written after async records), or - when none is expected - for long enough
   * that one would have been.
   */
  const wake = async (expected = true): Promise<string[]> => {
    for (let attempt = 0; attempt < (expected ? 200 : 10); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5))
      await waker.idle()
      for (const timer of timers.splice(0)) timer()
      await waker.idle()
      if (delivered.length > 0) break
    }
    return delivered.splice(0)
  }

  const spawner = createTicketSpawner({
    worktrees: {
      async create(worktree) {
        return {
          ok: true,
          worktree: { path: `D:\\project-${worktree.branch}`, branch: worktree.branch, baseRef: 'main' }
        }
      }
    },
    runGit: async () => ({ code: 0, stdout: '', stderr: '' }),
    installGuard: async () => ({ ok: true }),
    project: async () => ({ id: 'project-1', setupCommand: 'npm ci' }),
    runSetup: async () => ({ ok: true }),
    canvas: {
      startTicketSession: (request, observer) => requests.request(request, observer),
      cancelTicketSession: (nodeId) => {
        cancelled.push(nodeId)
        requests.cancel(nodeId)
      }
    },
    session: (nodeId) => (live.has(nodeId) ? { model: 'claude-opus-5-5', effort: 'high' } : undefined),
    offeredModels: () => [],
    offeredEfforts: () => undefined,
    onWorktreeCreated: () => undefined
  })

  const endpoint = createOrchestratorEndpoint({
    records,
    spawner,
    ticketSessions: {
      state: (nodeId) => {
        const session = live.get(nodeId)
        return session && ({ status: session.status, questions: [] } as never)
      },
      startPrompt: () => ({ ok: true }),
      promptWhenIdle: async () => ({ ok: true }),
      answerQuestion: () => ({ ok: true }),
      outcome: async () => undefined,
      stop: (nodeId, options) => {
        killed.push({ nodeId, ...options })
        live.delete(nodeId)
      }
    },
    onTicketSpawned: (nodeId, binding) => waker.bind(nodeId, binding),
    onTicketAbandoned: (nodeId) => {
      stopped.push(nodeId)
      waker.unbind(nodeId)
    },
    onTicketStartSettled: (binding, outcome) =>
      waker.report(binding, outcome.ok ? { kind: 'started' } : { kind: 'start-failed', reason: outcome.error }),
    now: () => '2026-11-05T12:00:00.000Z'
  })
  return {
    records,
    endpoint,
    requests,
    sent,
    live,
    cancelled,
    stopped,
    killed,
    waker,
    wake,
    expire: () => expire?.(),
    /** The renderer's side of the conversation; `request` is the one-based spawn it answers. */
    renderer: {
      requestOf: () =>
        sent.find((message) => message.channel === ORCHESTRATOR_CHANNELS.startTicketSession)!
          .args[1] as TicketSessionCanvasRequest,
      reportNode: (node = NODE, conversation = CONVERSATION, request = 1) =>
        requests.progress(`request-${request}`, { nodeId: node, conversationId: conversation }),
      answer: (result: Parameters<typeof requests.complete>[1], request = 1) =>
        requests.complete(`request-${request}`, result)
    }
  }
}

async function call(grant: OrchestratorGrant, command: string, args?: unknown) {
  const response = await fetch(grant.environment[ORCHESTRATOR_URL_ENV], {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${grant.environment[ORCHESTRATOR_TOKEN_ENV]}`
    },
    body: JSON.stringify({ command, args })
  })
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

async function planned() {
  const world = harness()
  const grant = (await world.endpoint.grant('orchestrator-1', { provider: 'claude', projectPath: 'D:\\project' }))!
  grant.setConversation('conversation-1')
  await call(grant, 'plan set', {
    task: 'Ship it',
    targetBranch: 'main',
    tickets: [{ id: '1', title: 'Spawn lifecycle' }]
  })
  const read = async (): Promise<OrchestrationRecord> =>
    (await world.records.read({ provider: 'claude', conversationId: 'conversation-1' }))!
  const ticketOf = async (): Promise<OrchestrationTicket> => (await read()).tickets[0]
  const status = async () =>
    ((await call(grant, 'status')).body.tickets as Array<{ state: string; session: unknown }>)[0]
  return { ...world, grant, read, ticketOf, status }
}

const spawn = { ticket: '1', model: 'claude-opus-5-5', effort: 'high' }

test('a wait that runs out keeps the session linked, shows it starting, and wakes the orchestrator when it is up', async () => {
  const world = await planned()
  try {
    const spawning = call(world.grant, 'spawn', spawn)
    // The canvas has the node and the session is still launching: nothing has answered yet.
    await waitFor(() => world.sent.length === 1)
    world.renderer.reportNode()
    await waitFor(async () => (await world.ticketOf()).session?.nodeId === NODE)

    // Recorded before the session is ready, as a run that is still starting.
    const early = await world.ticketOf()
    assert.deepEqual(early.session, {
      nodeId: NODE,
      conversationId: CONVERSATION,
      worktreePath: 'D:\\project-ticket/1',
      branch: 'ticket/1'
    })
    assert.equal(early.runs?.at(-1)?.state, 'starting')

    world.expire()
    const reply = await spawning
    assert.equal(reply.status, 202)
    assert.equal(reply.body.ok, false)
    assert.equal(reply.body.pending, true)
    assert.equal(reply.body.ticket, '1')
    assert.deepEqual(reply.body.session, early.session)
    assert.match(String(reply.body.error), /still starting/)

    // Not a failure: nothing is closed, the ticket keeps its link, and status says it is starting.
    assert.deepEqual(world.cancelled, [])
    assert.equal((await world.ticketOf()).session?.nodeId, NODE)
    assert.equal((await world.status()).state, 'starting')

    // It comes up and starts working: status follows the live session, and the orchestrator is woken.
    world.live.set(NODE, { status: 'working' })
    world.renderer.answer({ ok: true, nodeId: NODE, conversationId: CONVERSATION })
    assert.equal((await world.status()).state, 'working')
    await waitFor(async () => (await world.ticketOf()).runs?.at(-1)?.state === undefined)
    const [startWake] = await world.wake()
    assert.match(startWake, /#1 finished starting/)

    // And when the session finishes its turn, the normal wake follows.
    const complete: AgentEvent = { type: 'turn_complete', stopReason: 'end_turn' }
    world.waker.observe(NODE, complete)
    const [doneWake] = await world.wake()
    assert.match(doneWake, /#1 completed/)
  } finally {
    await world.endpoint.close()
  }
})

test('a pending session that then fails is unlinked, and the orchestrator is told to spawn the ticket again', async () => {
  const world = await planned()
  try {
    const before = await world.ticketOf()
    const spawning = call(world.grant, 'spawn', spawn)
    await waitFor(() => world.sent.length === 1)
    world.renderer.reportNode()
    await waitFor(async () => (await world.ticketOf()).session?.nodeId === NODE)
    world.expire()
    assert.equal((await spawning).body.pending, true)

    world.renderer.answer({ ok: false, message: 'The ticket session could not be started on the desktop.' })
    await waitFor(async () => (await world.ticketOf()).session === undefined)

    const after = await world.ticketOf()
    assert.equal(after.session, before.session)
    assert.equal(after.runs, before.runs)
    assert.equal((await world.status()).state, 'not spawned')
    assert.deepEqual(world.stopped, [NODE])
    const [wake] = await world.wake()
    assert.match(wake, /#1 could not be started: The ticket session could not be started/)

    // The dead session's events are no longer the orchestrator's news.
    world.waker.observe(NODE, { type: 'turn_failed', message: 'adapter exited' } as AgentEvent)
    assert.deepEqual(await world.wake(false), [])
  } finally {
    await world.endpoint.close()
  }
})

test('a start that fails outright unlinks the session it recorded early and leaves the ticket spawnable', async () => {
  const world = await planned()
  try {
    const spawning = call(world.grant, 'spawn', spawn)
    await waitFor(() => world.sent.length === 1)
    world.renderer.reportNode()
    await waitFor(async () => (await world.ticketOf()).session?.nodeId === NODE)

    world.renderer.answer({ ok: false, message: 'The ticket session could not be started on the desktop.' })
    const reply = await spawning
    assert.equal(reply.status, 502)
    assert.equal(reply.body.pending, undefined)

    const ticket = await world.ticketOf()
    assert.equal(ticket.session, undefined)
    assert.equal(ticket.runs, undefined)
    assert.deepEqual(world.stopped, [NODE])
  } finally {
    await world.endpoint.close()
  }
})

test('a session that comes up after the spawn was refused is withdrawn, not left working the ticket', async () => {
  const world = await planned()
  try {
    // The window never reports the node, so there is nothing to link when the wait runs out.
    const spawning = call(world.grant, 'spawn', spawn)
    await waitFor(() => world.sent.length === 1)
    world.expire()
    const reply = await spawning
    assert.equal(reply.status, 502)
    assert.equal(reply.body.pending, undefined)

    world.renderer.answer({ ok: true, nodeId: NODE, conversationId: CONVERSATION })
    assert.deepEqual(world.cancelled, [NODE])
  } finally {
    await world.endpoint.close()
  }
})

/** Spawns once and lets the wait run out, leaving the ticket linked to a session that is still starting. */
async function pendingSpawn(world: Awaited<ReturnType<typeof planned>>) {
  const spawning = call(world.grant, 'spawn', spawn)
  await waitFor(() => world.sent.length === 1)
  world.renderer.reportNode()
  await waitFor(async () => (await world.ticketOf()).session?.nodeId === NODE)
  world.expire()
  assert.equal((await spawning).body.pending, true)
}

test('a second plain spawn while the first attempt is still starting is refused and names that attempt', async () => {
  const world = await planned()
  try {
    await pendingSpawn(world)
    const spawnsBefore = (await world.read()).spawnCount

    const reply = await call(world.grant, 'spawn', spawn)
    assert.equal(reply.status, 409)
    assert.equal(reply.body.ok, false)
    assert.equal(reply.body.duplicate, true)
    assert.deepEqual(reply.body.attempt, {
      attempt: 1,
      nodeId: NODE,
      branch: 'ticket/1',
      worktreePath: 'D:\\project-ticket/1',
      state: 'starting'
    })
    assert.match(
      String(reply.body.error),
      /attempt 1, branch ticket\/1, worktree D:\\project-ticket\/1, state starting/
    )
    assert.match(String(reply.body.error), /--replace/)

    // Nothing was created or counted, and the first attempt is untouched.
    assert.equal(world.sent.length, 1)
    assert.equal((await world.read()).spawnCount, spawnsBefore)
    assert.deepEqual(world.killed, [])
    assert.equal((await world.ticketOf()).session?.nodeId, NODE)
  } finally {
    await world.endpoint.close()
  }
})

test('a settled session awaiting review still blocks a plain spawn; an exited one does not', async () => {
  const world = await planned()
  try {
    await pendingSpawn(world)
    world.renderer.answer({ ok: true, nodeId: NODE, conversationId: CONVERSATION })
    await waitFor(async () => (await world.ticketOf()).runs?.at(-1)?.state === undefined)

    world.live.set(NODE, { status: 'ready' })
    const refused = await call(world.grant, 'spawn', spawn)
    assert.equal(refused.status, 409)
    assert.equal((refused.body.attempt as { state: string }).state, 'ready')

    world.live.set(NODE, { status: 'exited' })
    const second = call(world.grant, 'spawn', spawn)
    await waitFor(() => world.sent.length === 2)
    world.live.set('node-2', { status: 'working' })
    world.renderer.reportNode('node-2', 'conversation-2', 2)
    world.renderer.answer({ ok: true, nodeId: 'node-2', conversationId: 'conversation-2' }, 2)
    assert.equal((await second).status, 200)
    assert.deepEqual(world.killed, [])
  } finally {
    await world.endpoint.close()
  }
})

test('--replace stops the old attempt first, then spawns the new one', async () => {
  const world = await planned()
  try {
    await pendingSpawn(world)

    const replacing = call(world.grant, 'spawn', { ...spawn, replace: true })
    await waitFor(() => world.sent.length === 2)
    // The old session was stopped (and closed on the canvas, being unreported) before the new one began.
    assert.deepEqual(world.killed, [{ nodeId: NODE, starting: true }])
    assert.deepEqual(world.stopped, [NODE])

    world.live.set('node-2', { status: 'working' })
    world.renderer.reportNode('node-2', 'conversation-2', 2)
    world.renderer.answer({ ok: true, nodeId: 'node-2', conversationId: 'conversation-2' }, 2)
    const reply = await replacing
    assert.equal(reply.status, 200)

    const ticket = await world.ticketOf()
    assert.equal(ticket.session?.nodeId, 'node-2')
    assert.equal(ticket.runs?.length, 2)
    assert.equal(ticket.runs?.at(-1)?.conversationId, 'conversation-2')
    assert.equal((await world.read()).spawnCount, 2)
  } finally {
    await world.endpoint.close()
  }
})

test('--replace with nothing unresolved just spawns, and a refused replace does not stop the old attempt', async () => {
  const world = await planned()
  try {
    const first = call(world.grant, 'spawn', { ...spawn, replace: true })
    await waitFor(() => world.sent.length === 1)
    world.live.set(NODE, { status: 'working' })
    world.renderer.reportNode()
    world.renderer.answer({ ok: true, nodeId: NODE, conversationId: CONVERSATION })
    assert.equal((await first).status, 200)
    assert.deepEqual(world.killed, [])

    // A replace that fails its own validation leaves the working attempt alone.
    const refused = await call(world.grant, 'spawn', { ticket: '1', replace: 'yes' })
    assert.equal(refused.status, 400)
    assert.match(String(refused.body.error), /--replace takes no value/)
    assert.deepEqual(world.killed, [])
    assert.equal((await world.ticketOf()).session?.nodeId, NODE)
  } finally {
    await world.endpoint.close()
  }
})

async function waitFor(condition: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await condition()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('condition was never met')
}

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
  orchestrationBranchScope,
  type OrchestrationRecord,
  type OrchestrationTicket
} from '../src/shared/orchestration'
import type { TicketSessionCanvasRequest } from '../src/shared/ticket-session-spawn'

/** Ticket 1's first branch, under this test orchestration's scope. */
const BRANCH = `ticket/${orchestrationBranchScope({ provider: 'claude', conversationId: 'conversation-1' })}/1`
const WORKTREE = `D:\\project-${BRANCH}`

/**
 * Tucaen/toucan#3 (and issue #1 before it), end to end through the real parts: an orchestrator's
 * `spawn` answers as soon as the attempt is recorded, while the setup command and the canvas still
 * run. The ticket keeps its attempt, `status` shows it starting, a second plain spawn is refused,
 * and the orchestrator is woken with `started` or `start-failed` however long after `spawn` answered.
 */

const NODE = 'ticket-node'
const CONVERSATION = 'ticket-conversation'

type SetupResult = { ok: true } | { ok: false; error: string }

function harness() {
  const records = createOrchestrationStore({ directory: mkdtempSync(join(tmpdir(), 'toucan-spawn-pending-')) })

  // The canvas wait runs out when the test says so.
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
  const git: string[][] = []
  /** What happened to held setups and removed worktrees, in order. */
  const events: string[] = []

  /** Setup commands finish at once unless the test holds them; held ones wait for `finish`. */
  const setup = {
    hold: false,
    result: { ok: true } as SetupResult,
    held: [] as Array<{ signal?: AbortSignal; finish(result?: SetupResult): void }>
  }

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

  const branches = new Set<string>()
  const spawner = createTicketSpawner({
    worktrees: {
      // Like git: a branch a kept worktree still has is taken.
      async create(worktree) {
        if (branches.has(worktree.branch)) return { ok: false, conflict: true, message: 'Branch exists' }
        branches.add(worktree.branch)
        return {
          ok: true,
          worktree: { path: `D:\\project-${worktree.branch}`, branch: worktree.branch, baseRef: 'main' }
        }
      }
    },
    runGit: async (args) => {
      git.push(args)
      return { code: 0, stdout: '', stderr: '' }
    },
    installGuard: async () => ({ ok: true }),
    project: async () => ({ id: 'project-1', setupCommand: 'npm ci' }),
    runSetup: (_command, _cwd, signal) =>
      setup.hold
        ? new Promise((resolve) => {
            const finish = (result: SetupResult = setup.result) => resolve(result)
            // Like a killed process tree, it takes a moment to be gone.
            signal?.addEventListener('abort', () =>
              setTimeout(() => {
                events.push('setup stopped')
                finish({ ok: false, error: '"npm ci" was cancelled' })
              }, 10)
            )
            setup.held.push({ signal, finish })
          })
        : Promise.resolve(setup.result),
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

  /** An endpoint over the same records; a second one is Toucan after a restart. */
  const endpointOver = () =>
    createOrchestratorEndpoint({
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
      onTicketStartSettled: (binding, outcome) => waker.report(binding, outcome),
      cleanup: {
        discard: async (_record: OrchestrationRecord, target: { branch: string }) => {
          events.push(`removed ${target.branch}`)
          return { ok: true }
        }
      } as never,
      now: () => '2026-11-05T12:00:00.000Z'
    })
  return {
    records,
    endpoint: endpointOver(),
    endpointOver,
    requests,
    sent,
    live,
    cancelled,
    stopped,
    killed,
    git,
    events,
    setup,
    waker,
    wake,
    expire: () => expire?.(),
    /** How many ticket sessions the canvas was asked to start. */
    starts: () => sent.filter((message) => message.channel === ORCHESTRATOR_CHANNELS.startTicketSession).length,
    /** The renderer's side of the conversation; `request` is the one-based start it answers. */
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
  const granted = async (endpoint: typeof world.endpoint): Promise<OrchestratorGrant> => {
    const grant = (await endpoint.grant('orchestrator-1', { provider: 'claude', projectPath: 'D:\\project' }))!
    grant.setConversation('conversation-1')
    return grant
  }
  const grant = await granted(world.endpoint)
  await call(grant, 'plan set', {
    task: 'Ship it',
    targetBranch: 'main',
    tickets: [{ id: '1', title: 'Spawn lifecycle' }]
  })
  const read = async (): Promise<OrchestrationRecord> =>
    (await world.records.read({ provider: 'claude', conversationId: 'conversation-1' }))!
  const ticketOf = async (): Promise<OrchestrationTicket> => (await read()).tickets[0]
  const status = async (as = grant) =>
    ((await call(as, 'status')).body.tickets as Array<{ state: string; session: unknown }>)[0]
  return { ...world, grant, granted, read, ticketOf, status }
}

const spawn = { ticket: '1', model: 'claude-opus-5-5', effort: 'high' }

/** Spawns, and has the canvas show the node; the session is still launching. */
async function spawnToCanvas(world: Awaited<ReturnType<typeof planned>>, request = 1) {
  const reply = await call(world.grant, 'spawn', spawn)
  assert.equal(reply.status, 200)
  await waitFor(() => world.starts() === request)
  world.renderer.reportNode(request === 1 ? NODE : `node-${request}`, `conversation-${request}`, request)
  await waitFor(async () => (await world.ticketOf()).session?.nodeId === (request === 1 ? NODE : `node-${request}`))
  return reply
}

test('spawn answers with the attempt starting, and the orchestrator is woken when its session is up', async () => {
  const world = await planned()
  world.setup.hold = true
  try {
    const reply = await call(world.grant, 'spawn', spawn)
    // Answered with the setup command still running: the attempt, but no session yet.
    assert.equal(reply.status, 200)
    assert.equal(reply.body.ok, true)
    assert.equal(reply.body.ticket, '1')
    assert.equal(reply.body.state, 'starting')
    assert.equal(reply.body.attempt, 1)
    assert.deepEqual(reply.body.session, { worktreePath: WORKTREE, branch: BRANCH })
    assert.equal((reply.body.route as { model: string }).model, 'claude-opus-5-5')
    assert.equal(world.starts(), 0)

    // Recorded as a run that is still starting, which status shows.
    const early = await world.ticketOf()
    assert.deepEqual(early.session, { worktreePath: WORKTREE, branch: BRANCH })
    assert.equal(early.runs?.at(-1)?.state, 'starting')
    assert.equal((await world.status()).state, 'starting')

    // The setup command finishes and the canvas shows the node, still launching.
    world.setup.held[0].finish()
    await waitFor(() => world.starts() === 1)
    world.renderer.reportNode()
    await waitFor(async () => (await world.ticketOf()).session?.nodeId === NODE)
    assert.deepEqual((await world.ticketOf()).session, {
      nodeId: NODE,
      conversationId: CONVERSATION,
      worktreePath: WORKTREE,
      branch: BRANCH
    })

    // The canvas wait running out with the node shown is no verdict: nothing is closed, no wake.
    world.expire()
    assert.deepEqual(await world.wake(false), [])
    assert.deepEqual(world.cancelled, [])
    assert.equal((await world.status()).state, 'starting')

    // It comes up and starts working: status follows the live session, and the orchestrator is woken.
    world.live.set(NODE, { status: 'working' })
    world.renderer.answer({ ok: true, nodeId: NODE, conversationId: CONVERSATION })
    assert.equal((await world.status()).state, 'working')
    await waitFor(async () => (await world.ticketOf()).runs?.at(-1)?.state === undefined)
    const [startWake] = await world.wake()
    assert.match(startWake, /#1 finished starting on claude-opus-5-5 at effort high/)

    // And when the session finishes its turn, the normal wake follows.
    const complete: AgentEvent = { type: 'turn_complete', stopReason: 'end_turn' }
    world.waker.observe(NODE, complete)
    const [doneWake] = await world.wake()
    assert.match(doneWake, /#1 completed/)
  } finally {
    await world.endpoint.close()
  }
})

test('a failing setup command removes the worktree, unlinks the attempt and wakes the orchestrator', async () => {
  const world = await planned()
  world.setup.result = { ok: false, error: 'npm ERR! missing script' }
  try {
    const before = await world.ticketOf()
    assert.equal((await call(world.grant, 'spawn', spawn)).status, 200)

    const [wake] = await world.wake()
    assert.match(wake, /#1 could not be started: the setup command failed: npm ERR! missing script/)
    assert.match(wake, /the worktree and its branch were removed again/)
    // Nothing is left before the canvas opens.
    assert.equal(world.starts(), 0)
    assert.deepEqual(world.git, [
      ['worktree', 'remove', '--force', WORKTREE],
      ['branch', '-D', BRANCH]
    ])
    const after = await world.ticketOf()
    assert.equal(after.session, before.session)
    assert.equal(after.runs, before.runs)
    assert.equal((await world.status()).state, 'not spawned')
  } finally {
    await world.endpoint.close()
  }
})

test('a session that fails after the canvas showed it is unlinked, its node kept, and the orchestrator told', async () => {
  const world = await planned()
  try {
    const before = await world.ticketOf()
    await spawnToCanvas(world)
    world.expire()

    world.renderer.answer({ ok: false, message: 'The ticket session could not be started on the desktop.' })
    // The record is written before the abandon hook runs, so wait for both.
    await waitFor(async () => (await world.ticketOf()).session === undefined && world.stopped.length > 0)

    const after = await world.ticketOf()
    assert.equal(after.session, before.session)
    assert.equal(after.runs, before.runs)
    assert.equal((await world.status()).state, 'not spawned')
    assert.deepEqual(world.stopped, [NODE])
    // The worktree and the node stay for the human.
    assert.deepEqual(world.git, [])
    const [wake] = await world.wake()
    assert.match(wake, /#1 could not be started: The ticket session could not be started on the desktop\./)
    assert.match(wake, /its node stays on the canvas without the ticket prompt/)
    assert.match(wake, /spawn the ticket again/)

    // The dead session's events are no longer the orchestrator's news.
    world.waker.observe(NODE, { type: 'turn_failed', message: 'adapter exited' } as AgentEvent)
    assert.deepEqual(await world.wake(false), [])
  } finally {
    await world.endpoint.close()
  }
})

test('a session that comes up after the canvas gave up without a node is withdrawn, not left working', async () => {
  const world = await planned()
  try {
    assert.equal((await call(world.grant, 'spawn', spawn)).status, 200)
    // The window never reports the node, so there is nothing to keep when the wait runs out.
    await waitFor(() => world.starts() === 1)
    world.expire()
    const [wake] = await world.wake()
    assert.match(wake, /#1 could not be started: the canvas did not show the ticket session in time/)
    assert.equal((await world.ticketOf()).session, undefined)

    world.renderer.answer({ ok: true, nodeId: NODE, conversationId: CONVERSATION })
    assert.deepEqual(world.cancelled, [NODE])
  } finally {
    await world.endpoint.close()
  }
})

test('a second plain spawn while the first attempt is still in setup is refused and names that attempt', async () => {
  const world = await planned()
  world.setup.hold = true
  try {
    assert.equal((await call(world.grant, 'spawn', spawn)).status, 200)
    const spawnsBefore = (await world.read()).spawnCount

    const reply = await call(world.grant, 'spawn', spawn)
    assert.equal(reply.status, 409)
    assert.equal(reply.body.duplicate, true)
    assert.deepEqual(reply.body.attempt, { attempt: 1, branch: BRANCH, worktreePath: WORKTREE, state: 'starting' })
    assert.match(String(reply.body.error), /--replace/)
    assert.equal((await world.read()).spawnCount, spawnsBefore)
    assert.equal(world.setup.held.length, 1)
  } finally {
    await world.endpoint.close()
  }
})

test('a second plain spawn while the first session is still coming up is refused and names that attempt', async () => {
  const world = await planned()
  try {
    await spawnToCanvas(world)
    const spawnsBefore = (await world.read()).spawnCount

    const reply = await call(world.grant, 'spawn', spawn)
    assert.equal(reply.status, 409)
    assert.equal(reply.body.ok, false)
    assert.equal(reply.body.duplicate, true)
    assert.deepEqual(reply.body.attempt, {
      attempt: 1,
      nodeId: NODE,
      branch: BRANCH,
      worktreePath: WORKTREE,
      state: 'starting'
    })
    assert.ok(String(reply.body.error).includes(`attempt 1, branch ${BRANCH}, worktree ${WORKTREE}, state starting`))
    assert.match(String(reply.body.error), /--replace/)

    // Nothing was created or counted, and the first attempt is untouched.
    assert.equal(world.starts(), 1)
    assert.equal((await world.read()).spawnCount, spawnsBefore)
    assert.deepEqual(world.killed, [])
    assert.equal((await world.ticketOf()).session?.nodeId, NODE)
  } finally {
    await world.endpoint.close()
  }
})

test('an attempt a restart interrupted in setup reads as not running and does not block a spawn', async () => {
  const world = await planned()
  world.setup.hold = true
  const restarted = world.endpointOver()
  try {
    assert.equal((await call(world.grant, 'spawn', spawn)).status, 200)
    // Toucan restarts: nothing is setting that attempt up any more.
    const grant = await world.granted(restarted)
    assert.equal((await world.status(grant)).state, 'not running')
    assert.equal((await call(grant, 'spawn', spawn)).status, 200)
  } finally {
    await world.endpoint.close()
    await restarted.close()
  }
})

test('a settled session awaiting review still blocks a plain spawn; an exited one does not', async () => {
  const world = await planned()
  try {
    await spawnToCanvas(world)
    world.renderer.answer({ ok: true, nodeId: NODE, conversationId: CONVERSATION })
    await waitFor(async () => (await world.ticketOf()).runs?.at(-1)?.state === undefined)

    world.live.set(NODE, { status: 'ready' })
    const refused = await call(world.grant, 'spawn', spawn)
    assert.equal(refused.status, 409)
    assert.equal((refused.body.attempt as { state: string }).state, 'ready')

    world.live.set(NODE, { status: 'exited' })
    assert.equal((await call(world.grant, 'spawn', spawn)).status, 200)
    assert.deepEqual(world.killed, [])
  } finally {
    await world.endpoint.close()
  }
})

test('--replace stops the old attempt first, then spawns the new one', async () => {
  const world = await planned()
  try {
    await spawnToCanvas(world)

    const reply = await call(world.grant, 'spawn', { ...spawn, replace: true })
    assert.equal(reply.status, 200)
    // The old session was stopped (and closed on the canvas, being unreported) before the new one began.
    assert.deepEqual(world.killed, [{ nodeId: NODE, starting: true }])
    assert.deepEqual(world.stopped, [NODE])

    await waitFor(() => world.starts() === 2)
    world.live.set('node-2', { status: 'working' })
    world.renderer.reportNode('node-2', 'conversation-2', 2)
    world.renderer.answer({ ok: true, nodeId: 'node-2', conversationId: 'conversation-2' }, 2)
    await waitFor(async () => (await world.ticketOf()).runs?.at(-1)?.state === undefined)

    const ticket = await world.ticketOf()
    assert.equal(ticket.session?.nodeId, 'node-2')
    assert.equal(ticket.runs?.length, 2)
    assert.equal(ticket.runs?.at(-1)?.conversationId, 'conversation-2')
    assert.equal((await world.read()).spawnCount, 2)
    // Only the new attempt's start is the orchestrator's news.
    const wakes = await world.wake()
    assert.equal(wakes.length, 1)
    assert.match(wakes[0], /#1 finished starting/)
    assert.doesNotMatch(wakes[0], /could not be started/)
  } finally {
    await world.endpoint.close()
  }
})

test('--replace stops an attempt still in setup, and that attempt is not reported', async () => {
  const world = await planned()
  world.setup.hold = true
  try {
    assert.equal((await call(world.grant, 'spawn', spawn)).status, 200)
    const reply = await call(world.grant, 'spawn', { ...spawn, replace: true })
    assert.equal(reply.status, 200)
    assert.equal(world.setup.held[0].signal?.aborted, true)
    // Nothing of the first attempt reached the canvas, and its worktree stays.
    assert.deepEqual(world.killed, [])
    assert.deepEqual(world.git, [])

    world.setup.held[1].finish()
    await waitFor(() => world.starts() === 1)
    world.live.set(NODE, { status: 'working' })
    world.renderer.reportNode()
    world.renderer.answer({ ok: true, nodeId: NODE, conversationId: CONVERSATION })
    await waitFor(async () => (await world.ticketOf()).runs?.at(-1)?.state === undefined)
    const ticket = await world.ticketOf()
    assert.equal(ticket.session?.branch, `${BRANCH}-2`)
    assert.equal(ticket.runs?.length, 2)
    const wakes = await world.wake()
    assert.equal(wakes.length, 1)
    assert.doesNotMatch(wakes[0], /could not be started/)
  } finally {
    await world.endpoint.close()
  }
})

test('discard stops an attempt still in setup before its worktree is removed, and it is not reported', async () => {
  const world = await planned()
  world.setup.hold = true
  try {
    assert.equal((await call(world.grant, 'spawn', spawn)).status, 200)
    const reply = await call(world.grant, 'discard', { ticket: '1', attempt: 1 })
    assert.equal(reply.status, 200, JSON.stringify(reply.body))
    assert.deepEqual(world.events, ['setup stopped', `removed ${BRANCH}`])
    assert.equal(world.starts(), 0)
    assert.deepEqual(await world.wake(false), [])
  } finally {
    await world.endpoint.close()
  }
})

test('--replace with nothing unresolved just spawns, and a refused replace does not stop the old attempt', async () => {
  const world = await planned()
  try {
    assert.equal((await call(world.grant, 'spawn', { ...spawn, replace: true })).status, 200)
    await waitFor(() => world.starts() === 1)
    world.live.set(NODE, { status: 'working' })
    world.renderer.reportNode()
    world.renderer.answer({ ok: true, nodeId: NODE, conversationId: CONVERSATION })
    await waitFor(async () => (await world.ticketOf()).session?.nodeId === NODE)
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

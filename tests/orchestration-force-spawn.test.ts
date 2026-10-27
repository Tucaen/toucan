import { strict as assert } from 'node:assert'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'
import { workingSessionCounts } from '../src/main/orchestrated-ticket-sessions'
import { createOrchestrationStartNow } from '../src/main/orchestration-start-now'
import { createOrchestrationStore } from '../src/main/orchestration-store'
import { createOrchestratorEndpoint, type OrchestratorGrant } from '../src/main/orchestrator-endpoint'
import { createProviderUsage } from '../src/main/provider-usage'
import type { TicketSpawner, TicketSpawnRequest } from '../src/main/ticket-spawner'
import {
  SPAWNS_PER_CHECKPOINT,
  ORCHESTRATOR_ROLE,
  ORCHESTRATOR_TOKEN_ENV,
  ORCHESTRATOR_URL_ENV,
  isOrchestrationRecord,
  pacingDeferral,
  parseSpawnInput,
  pauseOrchestration,
  stopOrchestration
} from '../src/shared/orchestration'
import { BURN_RATE_MIN_SPAN_MS, usageBurnRate, usageOutlook } from '../src/shared/orchestration-pacing'

// `spawn --force --reason`: the orchestrator starts a ticket regardless of the usage limits, when
// the user asks or when the outlook shows the remaining usage suffices. Toucan always honours it,
// records the override on `pacing.forced`, resumes a reactive pause, and clears a pending deferral
// so its reopen wake cannot start the ticket a second time.

const plan = {
  task: 'Ship orchestrator mode',
  targetBranch: 'main',
  tickets: [
    { id: '33', title: 'Foundation' },
    { id: '34', title: 'Spawn' }
  ]
}

const spawn34 = { ticket: '34', model: 'claude-opus-5-5', effort: 'high' }
const force34 = { ...spawn34, force: true, reason: 'user asked to start now' }
const NOW = 100_000
const RESET = NOW + 30 * 60_000

function fakeSpawner(): TicketSpawner & { calls: TicketSpawnRequest[] } {
  const calls: TicketSpawnRequest[] = []
  return {
    calls,
    async spawn(request) {
      calls.push(request)
      return {
        ok: true,
        session: {
          nodeId: `node-${calls.length}`,
          conversationId: `ticket-conversation-${calls.length}`,
          worktreePath: `D:\\project-ticket-${request.ticket.id}`,
          branch: `ticket/${request.ticket.id}`
        },
        model: request.model,
        effort: request.effort,
        warnings: []
      }
    }
  }
}

async function call(
  grant: OrchestratorGrant,
  command: string,
  args?: unknown
): Promise<{ status: number; body: { ok: boolean; error?: string; [key: string]: unknown } }> {
  const response = await fetch(grant.environment[ORCHESTRATOR_URL_ENV], {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${grant.environment[ORCHESTRATOR_TOKEN_ENV]}`
    },
    body: JSON.stringify({ command, args })
  })
  return { status: response.status, body: (await response.json()) as never }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

/** An enforced-pacing endpoint whose usage, clock and timers the test drives. */
async function harness(initialPercent = 90) {
  const records = createOrchestrationStore({ directory: mkdtempSync(join(tmpdir(), 'toucan-orchestrator-force-')) })
  const usage = { percent: initialPercent, rejected: false }
  const clock = { now: NOW }
  const providerUsage = createProviderUsage({
    readers: {
      claude: {
        read: () => ({
          fiveHour: { usedPercent: usage.percent, resetsAt: RESET },
          ...(usage.rejected ? { rejected: true } : {})
        })
      }
    },
    ttlMs: 0,
    now: () => clock.now
  })
  const spawner = fakeSpawner()
  const timers: Array<{ callback: () => void; cancelled: boolean }> = []
  const wakes: string[] = []
  const resumed: string[] = []
  const endpoint = createOrchestratorEndpoint({
    records,
    spawner,
    providerUsage,
    resumePaused: async (key, orchestratorNodeId) => {
      resumed.push(orchestratorNodeId)
      await records.update(key, (current) => {
        if (!current) return { value: current, result: undefined }
        const { lifecycle: _lifecycle, ...running } = current
        return { value: running, result: undefined }
      })
    },
    pacing: {
      enforce: true,
      activeTicketSessions: () => 0,
      workingSessions: () => ({ tickets: 1, orchestrators: 1, chats: 0 }),
      wake: async (nodeId) => {
        wakes.push(nodeId)
        return { ok: true }
      },
      schedule: (callback) => {
        const timer = { callback, cancelled: false }
        timers.push(timer)
        return () => {
          timer.cancelled = true
        }
      }
    },
    now: () => new Date(clock.now).toISOString()
  })
  const grant = (await endpoint.grant('orchestrator-1', { provider: 'claude', projectPath: 'D:\\project' }))!
  grant.setConversation('conversation-1')
  assert.equal((await call(grant, 'plan set', plan)).status, 200)
  const key = { provider: 'claude' as const, conversationId: 'conversation-1' }
  return { records, endpoint, grant, spawner, usage, clock, timers, wakes, resumed, key }
}

test('a forced spawn passes the pause threshold, clears the deferral and records the override', async () => {
  const { records, endpoint, grant, spawner, timers, wakes, key } = await harness()
  try {
    const deferred = await call(grant, 'spawn', spawn34)
    assert.equal(deferred.status, 429)
    assert.equal(deferred.body.deferred, true)
    assert.equal(deferred.body.reason, 'five_hour_pause_threshold')
    assert.match(deferred.body.error ?? '', /--force --reason/)
    assert.equal(timers.length, 1)

    const forced = await call(grant, 'spawn', force34)
    assert.equal(forced.status, 200, JSON.stringify(forced.body))
    const override = {
      ticketId: '34',
      by: 'orchestrator-1',
      at: new Date(NOW).toISOString(),
      reason: 'user asked to start now'
    }
    assert.deepEqual(forced.body.forced, override)
    assert.equal(spawner.calls.length, 1)

    const record = await records.read(key)
    assert.equal(record?.spawnCount, 1)
    assert.deepEqual(record?.pacing, { forced: override })
    assert.deepEqual((await call(grant, 'status')).body.pacing, { forced: override })
    assert.deepEqual((await call(grant, 'report')).body.forcedSpawns, [
      { conversationId: 'conversation-1', ...override }
    ])
    assert.equal(timers[0].cancelled, true, 'the pending reopen timer is cancelled')

    // Pacing still governs the next, unforced spawn, and a new deferral keeps the audit.
    const next = await call(grant, 'spawn', { ticket: '33', model: 'claude-opus-5-5', effort: 'high' })
    assert.equal(next.status, 429)
    assert.equal(next.body.deferred, true)
    assert.equal(spawner.calls.length, 1)
    const after = await records.read(key)
    assert.equal(pacingDeferral(after)?.state, 'pause')
    assert.deepEqual(after?.pacing?.forced, override)
    assert.equal(isOrchestrationRecord(after), true)
    assert.deepEqual(wakes, [])
  } finally {
    await endpoint.close()
  }
})

test('the reopen wake after a forced spawn neither fires nor starts the ticket again', async () => {
  const { endpoint, grant, spawner, usage, timers, wakes } = await harness()
  try {
    assert.equal((await call(grant, 'spawn', spawn34)).status, 429)
    assert.equal((await call(grant, 'spawn', force34)).status, 200)

    // The reset arrives anyway: a late timer, an activity change and the session turning ready.
    usage.percent = 10
    for (const timer of timers) timer.callback()
    endpoint.pacingActivityChanged('claude')
    endpoint.pacingSessionReady('orchestrator-1')
    await settle()
    assert.deepEqual(wakes, [])
    assert.equal(spawner.calls.length, 1)
    const ticket = ((await call(grant, 'status')).body.tickets as Array<{ id: string; state: string }>).find(
      (entry) => entry.id === '34'
    )
    assert.notEqual(ticket?.state, 'not spawned')
  } finally {
    await endpoint.close()
  }
})

test('--force needs a reason, and a reason needs --force', async () => {
  const { records, endpoint, grant, spawner, key } = await harness()
  try {
    const bare = await call(grant, 'spawn', { ...spawn34, force: true })
    assert.equal(bare.status, 400)
    assert.match(bare.body.error ?? '', /--force needs --reason/)
    const stray = await call(grant, 'spawn', { ...spawn34, reason: 'why not' })
    assert.equal(stray.status, 400)
    assert.match(stray.body.error ?? '', /--reason goes with --force/)
    assert.equal(spawner.calls.length, 0)
    assert.equal((await records.read(key))?.spawnCount, undefined)
  } finally {
    await endpoint.close()
  }
})

test('a forced spawn ignores every usage limit, even 100% and a provider refusal', async () => {
  const { endpoint, grant, spawner, usage } = await harness(100)
  try {
    usage.rejected = true
    const forced = await call(grant, 'spawn', force34)
    assert.equal(forced.status, 200, JSON.stringify(forced.body))
    assert.equal(spawner.calls.length, 1)
  } finally {
    await endpoint.close()
  }
})

test('a forced spawn resumes an orchestration paused by a usage limit', async () => {
  const { records, endpoint, grant, spawner, resumed, key } = await harness()
  try {
    await records.update(key, (current) => ({
      value: current && pauseOrchestration(current, 'node-1', RESET, current.updatedAt),
      result: undefined
    }))
    const unforced = await call(grant, 'spawn', spawn34)
    assert.match(unforced.body.error ?? '', /paused/)
    assert.deepEqual(resumed, [])

    const forced = await call(grant, 'spawn', force34)
    assert.equal(forced.status, 200, JSON.stringify(forced.body))
    assert.deepEqual(resumed, ['orchestrator-1'])
    assert.equal(spawner.calls.length, 1)
    assert.equal((await records.read(key))?.lifecycle, undefined)
  } finally {
    await endpoint.close()
  }
})

test('a forced spawn still honours blockedBy, the spawn budget and a stopped orchestration', async () => {
  const { records, endpoint, grant, spawner, key } = await harness()
  try {
    await call(grant, 'ticket update', { id: '34', fields: { blockedBy: ['33'] } })
    const blocked = await call(grant, 'spawn', force34)
    assert.equal(blocked.status, 429)
    assert.match(blocked.body.error ?? '', /unmerged blockers.*33/)

    await call(grant, 'ticket update', { id: '34', fields: { blockedBy: [] } })
    await records.update(key, (current) => ({
      value: current && { ...current, spawnCount: SPAWNS_PER_CHECKPOINT },
      result: undefined
    }))
    const exhausted = await call(grant, 'spawn', force34)
    assert.equal(exhausted.status, 429)
    assert.match(exhausted.body.error ?? '', /spawn budget of 20/)
    // --force is a pacing override only: the checkpoint still answers budgetReached.
    assert.equal(exhausted.body.budgetReached, true)

    await records.update(key, (current) => ({
      value: current && stopOrchestration({ ...current, spawnCount: 0 }, current.updatedAt),
      result: undefined
    }))
    const stopped = await call(grant, 'spawn', force34)
    assert.match(stopped.body.error ?? '', /stopped/)
    assert.equal(spawner.calls.length, 0)
  } finally {
    await endpoint.close()
  }
})

test('usage and a deferral carry the outlook measured from Toucan readings', async () => {
  const { endpoint, grant, usage, clock } = await harness(80)
  try {
    const first = await call(grant, 'usage')
    assert.equal(first.status, 200)
    const unknown = first.body.outlook as { burnRatePerMinute: unknown; usedPercent: number; minutesToReset: number }
    assert.equal(unknown.burnRatePerMinute, null, 'one reading is no rate yet')
    assert.equal(unknown.usedPercent, 80)
    assert.equal(unknown.minutesToReset, 30)

    clock.now = NOW + 10 * 60_000
    usage.percent = 90
    const deferred = await call(grant, 'spawn', spawn34)
    assert.equal(deferred.body.deferred, true)
    assert.deepEqual(deferred.body.outlook, {
      usedPercent: 90,
      resetsAt: RESET,
      minutesToReset: 20,
      burnRatePerMinute: 1,
      projectedAtReset: 110,
      projectedWithOneMore: 120,
      working: { tickets: 1, orchestrators: 1, chats: 0 }
    })
  } finally {
    await endpoint.close()
  }
})

test('the burn rate needs enough history and restarts after a reset', () => {
  const at = (minutes: number, usedPercent: number) => ({ at: NOW + minutes * 60_000, usedPercent })
  const now = NOW + 60 * 60_000
  assert.equal(usageBurnRate([], now), null)
  assert.equal(usageBurnRate([at(50, 10), at(52, 12)], now), null, 'under the minimum span')
  assert.equal(BURN_RATE_MIN_SPAN_MS, 5 * 60_000)
  assert.equal(usageBurnRate([at(40, 10), at(50, 20)], now), 1)
  assert.equal(usageBurnRate([at(-30, 0), at(40, 10), at(50, 20)], now), 1, 'readings older than an hour drop out')
  assert.equal(usageBurnRate([at(20, 95), at(40, 2), at(50, 7)], now), 0.5, 'the window starts after the drop')

  const outlook = usageOutlook({
    usage: { status: { fiveHour: { usedPercent: 90, resetsAt: now + 10 * 60_000 } }, readAt: now, stale: false },
    samples: [at(40, 80), at(50, 90)],
    working: { tickets: 0, orchestrators: 1, chats: 0 },
    now
  })
  assert.equal(outlook.projectedAtReset, 100)
  assert.equal(outlook.projectedWithOneMore, 110)
  const none = usageOutlook({ usage: null, samples: [], working: { tickets: 0, orchestrators: 0, chats: 0 }, now })
  assert.deepEqual(
    [none.usedPercent, none.minutesToReset, none.burnRatePerMinute, none.projectedWithOneMore],
    [null, null, null, null]
  )
})

test('working sessions count only mid-turn sessions of the provider, by kind', () => {
  const status: Record<string, 'working' | 'ready'> = {
    a: 'working',
    b: 'working',
    c: 'working',
    d: 'ready',
    e: 'working'
  }
  const counts = workingSessionCounts(
    [
      { id: 'a', kind: 'claude', orchestratedBy: { nodeId: 'o' } },
      { id: 'b', kind: 'claude', role: ORCHESTRATOR_ROLE },
      { id: 'c', kind: 'claude' },
      { id: 'd', kind: 'claude' },
      { id: 'e', kind: 'codex' },
      { id: 'f', kind: 'terminal' }
    ],
    'claude',
    (id) => status[id]
  )
  assert.deepEqual(counts, { tickets: 1, orchestrators: 1, chats: 1 })
})

test('Start now asks the orchestrator to force a startable ticket of its own orchestration', async () => {
  const records = createOrchestrationStore({ directory: mkdtempSync(join(tmpdir(), 'toucan-start-now-')) })
  const key = { provider: 'claude' as const, conversationId: 'conversation-1' }
  await records.update(key, () => {
    const value = {
      version: 1 as const,
      ...key,
      projectPath: 'D:\\project',
      task: 't',
      targetBranch: 'main',
      tickets: [
        { id: '33', title: 'Foundation', blockedBy: [], attempts: 0, mergeStatus: 'pending' as const },
        { id: '34', title: 'Spawn', blockedBy: ['33'], attempts: 0, mergeStatus: 'pending' as const }
      ],
      createdAt: 'now',
      updatedAt: 'now'
    }
    return { value, result: value }
  })
  const prompts: Array<[string, string]> = []
  const startNow = createOrchestrationStartNow({
    records,
    orchestratorFor: async (nodeId) => (nodeId === 'orchestrator-1' ? { key, orchestratorNodeId: nodeId } : undefined),
    wake: async (nodeId, prompt) => {
      prompts.push([nodeId, prompt])
      return { ok: true }
    }
  })

  assert.equal((await startNow({ key, nodeId: 'ticket-node', ticketId: '33' })).ok, false)
  assert.equal((await startNow({ key, nodeId: 'orchestrator-1', ticketId: '34' })).ok, false, 'blocked')
  assert.deepEqual(await startNow({ key, nodeId: 'orchestrator-1', ticketId: '33' }), { ok: true })
  await settle()
  assert.equal(prompts.length, 1)
  assert.equal(prompts[0][0], 'orchestrator-1')
  assert.match(prompts[0][1], /spawn --ticket 33 --force --reason/)
})

test('the spawn flags are parsed strictly', () => {
  assert.equal(parseSpawnInput({ ticket: '1', force: true, reason: ' asked ' }).spawn?.forceReason, 'asked')
  assert.equal(parseSpawnInput({ ticket: '1' }).spawn?.force, undefined)
  assert.match(parseSpawnInput({ ticket: '1', force: 'yes', reason: 'x' }).error ?? '', /--force takes no value/)
  assert.match(parseSpawnInput({ ticket: '1', force: true, reason: '  ' }).error ?? '', /--force needs --reason/)
})

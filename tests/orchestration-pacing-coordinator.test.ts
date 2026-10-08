import { strict as assert } from 'node:assert'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'
import { createOrchestrationPacingCoordinator } from '../src/main/orchestration-pacing-coordinator'
import { createOrchestrationStore } from '../src/main/orchestration-store'
import { createProviderUsage } from '../src/main/provider-usage'
import { applyPlan, type OrchestrationRecord } from '../src/shared/orchestration'
import type { AgentProvider, AgentRateLimitStatus } from '../src/shared/agent'

const NOW = Date.parse('2026-10-08T12:00:00.000Z')

function record(provider: AgentProvider, conversationId: string, projectPath: string): OrchestrationRecord {
  const applied = applyPlan(
    undefined,
    {
      task: 'Pace ticket work',
      targetBranch: 'main',
      tickets: [{ id: '50', title: 'Pacing', body: 'Enforce the provider gate', blockedBy: [] }]
    },
    { provider, conversationId, projectPath },
    new Date(NOW).toISOString()
  )
  if (!applied.record) throw new Error(applied.error)
  return applied.record
}

async function put(records: ReturnType<typeof createOrchestrationStore>, value: OrchestrationRecord): Promise<void> {
  await records.update(value, () => ({ value, result: undefined }))
}

function manualSchedule() {
  const tasks: Array<{ callback: () => void; ms: number; cancelled: boolean }> = []
  return {
    tasks,
    schedule(callback: () => void, ms: number) {
      const task = { callback, ms, cancelled: false }
      tasks.push(task)
      return () => {
        task.cancelled = true
      }
    },
    runNext() {
      const task = tasks.find((candidate) => !candidate.cancelled)
      if (!task) throw new Error('expected a scheduled recheck')
      task.cancelled = true
      task.callback()
    }
  }
}

test('same-provider admissions are atomic across projects while another provider stays independent', async () => {
  const records = createOrchestrationStore({ directory: mkdtempSync(join(tmpdir(), 'toucan-pacing-atomic-')) })
  const claudeA = record('claude', 'claude-a', 'D:\\project-a')
  const claudeB = record('claude', 'claude-b', 'D:\\project-b')
  const codex = record('codex', 'codex-a', 'D:\\project-c')
  await Promise.all([put(records, claudeA), put(records, claudeB), put(records, codex)])

  const resolvers = new Map<AgentProvider, (status: AgentRateLimitStatus) => void>()
  const reads = new Map<AgentProvider, number>()
  const usage = createProviderUsage({
    readers: {
      claude: {
        read: () => {
          reads.set('claude', (reads.get('claude') ?? 0) + 1)
          return new Promise<AgentRateLimitStatus>((resolve) => resolvers.set('claude', resolve))
        }
      },
      codex: {
        read: () => {
          reads.set('codex', (reads.get('codex') ?? 0) + 1)
          return new Promise<AgentRateLimitStatus>((resolve) => resolvers.set('codex', resolve))
        }
      }
    },
    ttlMs: 60_000,
    now: () => NOW
  })
  const coordinator = createOrchestrationPacingCoordinator({
    records,
    usage,
    enabled: true,
    activeTicketSessions: () => 0,
    wake: async () => ({ ok: true }),
    now: () => NOW
  })

  const first = coordinator.admit({ key: claudeA, orchestratorNodeId: 'captain-a' })
  const second = coordinator.admit({ key: claudeB, orchestratorNodeId: 'captain-b' })
  const independent = coordinator.admit({ key: codex, orchestratorNodeId: 'captain-c' })
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(reads.get('claude'), 1)
  assert.equal(reads.get('codex'), 1)
  resolvers.get('claude')?.({ fiveHour: { usedPercent: 75 } })
  resolvers.get('codex')?.({ fiveHour: { usedPercent: 75 } })

  const [one, two, other] = await Promise.all([first, second, independent])
  assert.equal(one.admitted, true)
  assert.deepEqual(two, {
    admitted: false,
    deferred: true,
    provider: 'claude',
    state: 'drain',
    reason: 'five_hour_drain_active_ticket_work'
  })
  assert.equal(other.admitted, true)
  assert.equal((await records.read(claudeA))?.spawnCount, undefined)
  assert.equal((await records.read(claudeB))?.pacing?.state, 'drain')
  coordinator.close()
})

test('a paused provider re-reads at each reset and wakes once only after the fresh policy reopens', async () => {
  const records = createOrchestrationStore({ directory: mkdtempSync(join(tmpdir(), 'toucan-pacing-reset-')) })
  const value = record('claude', 'conversation-1', 'D:\\project')
  await put(records, value)
  let clock = NOW
  const readings: AgentRateLimitStatus[] = [
    { fiveHour: { usedPercent: 90, resetsAt: NOW + 100 } },
    { fiveHour: { usedPercent: 90, resetsAt: NOW + 200 } },
    { fiveHour: { usedPercent: 20, resetsAt: NOW + 10_000 } }
  ]
  let reads = 0
  const usage = createProviderUsage({
    readers: { claude: { read: () => readings[reads++] ?? readings.at(-1)! } },
    ttlMs: 60_000,
    now: () => clock
  })
  const scheduler = manualSchedule()
  const wakes: string[] = []
  const coordinator = createOrchestrationPacingCoordinator({
    records,
    usage,
    enabled: true,
    activeTicketSessions: () => 0,
    wake: async (_nodeId, prompt) => {
      wakes.push(prompt)
      return { ok: true }
    },
    now: () => clock,
    schedule: scheduler.schedule
  })

  const deferred = await coordinator.admit({ key: value, orchestratorNodeId: 'captain' })
  assert.deepEqual(deferred, {
    admitted: false,
    deferred: true,
    provider: 'claude',
    state: 'pause',
    reason: 'five_hour_pause_threshold',
    retryAt: NOW + 100
  })
  assert.equal(scheduler.tasks.filter((task) => !task.cancelled).length, 1)

  clock = NOW + 100
  scheduler.runNext()
  await coordinator.idle()
  assert.equal(reads, 2)
  assert.equal(wakes.length, 0)
  assert.equal((await records.read(value))?.pacing?.retryAt, NOW + 200)

  clock = NOW + 200
  scheduler.runNext()
  await coordinator.idle()
  assert.equal(reads, 3)
  assert.equal(wakes.length, 1)
  assert.match(wakes[0], /usage.*status.*plan show/i)
  assert.equal((await records.read(value))?.pacing, undefined)
  assert.equal(scheduler.tasks.filter((task) => !task.cancelled).length, 0)
  coordinator.close()
})

test('a durable deferral is restored after restart and enforcement can be disabled', async () => {
  const records = createOrchestrationStore({ directory: mkdtempSync(join(tmpdir(), 'toucan-pacing-restart-')) })
  const value = record('claude', 'conversation-1', 'D:\\project')
  await put(records, value)
  let clock = NOW
  let usedPercent = 90
  let reads = 0
  const usage = createProviderUsage({
    readers: {
      claude: {
        read: () => {
          reads += 1
          return { fiveHour: { usedPercent, resetsAt: NOW + 100 } }
        }
      }
    },
    ttlMs: 60_000,
    now: () => clock
  })
  const firstSchedule = manualSchedule()
  const first = createOrchestrationPacingCoordinator({
    records,
    usage,
    enabled: true,
    activeTicketSessions: () => 0,
    wake: async () => ({ ok: true }),
    now: () => clock,
    schedule: firstSchedule.schedule
  })
  assert.equal((await first.admit({ key: value, orchestratorNodeId: 'captain' })).admitted, false)
  assert.equal((await records.read(value))?.pacing?.state, 'pause')
  first.close()

  clock = NOW + 100
  usedPercent = 20
  const wakes: string[] = []
  const restarted = createOrchestrationPacingCoordinator({
    records,
    usage,
    enabled: true,
    activeTicketSessions: () => 0,
    wake: async (_nodeId, prompt) => {
      wakes.push(prompt)
      return { ok: true }
    },
    now: () => clock,
    schedule: manualSchedule().schedule
  })
  await restarted.restore(value, 'captain')
  await restarted.idle()
  assert.equal(reads, 2)
  assert.equal(wakes.length, 1)
  assert.equal((await records.read(value))?.pacing, undefined)
  restarted.close()

  await put(records, {
    ...value,
    pacing: {
      state: 'pause',
      reason: 'five_hour_pause_threshold',
      constrainingWindow: 'five_hour',
      freshness: 'fresh',
      activeTicketSessions: 0,
      retryAt: NOW + 1_000,
      deferredAt: new Date(NOW).toISOString()
    }
  })
  const disabled = createOrchestrationPacingCoordinator({
    records,
    usage,
    enabled: false,
    activeTicketSessions: () => 99,
    wake: async () => ({ ok: true }),
    now: () => clock
  })
  await disabled.restore(value, 'captain')
  assert.equal((await records.read(value))?.pacing, undefined)
  const admitted = await disabled.admit({ key: value, orchestratorNodeId: 'captain' })
  assert.equal(admitted.admitted, true)
  assert.equal(reads, 2)
  if (admitted.admitted) admitted.release()
  disabled.close()
})

test('missing usage drains at one active ticket and coalesces active-count reopen wakes', async () => {
  const records = createOrchestrationStore({ directory: mkdtempSync(join(tmpdir(), 'toucan-pacing-missing-')) })
  const value = record('claude', 'conversation-1', 'D:\\project')
  await put(records, value)
  let active = 1
  let reads = 0
  const usage = createProviderUsage({
    readers: {
      claude: {
        read: () => {
          reads += 1
          return null
        }
      }
    },
    ttlMs: 60_000,
    now: () => NOW
  })
  const wakes: string[] = []
  const coordinator = createOrchestrationPacingCoordinator({
    records,
    usage,
    enabled: true,
    activeTicketSessions: () => active,
    wake: async (_nodeId, prompt) => {
      wakes.push(prompt)
      return { ok: true }
    },
    now: () => NOW
  })

  const deferred = await coordinator.admit({ key: value, orchestratorNodeId: 'captain' })
  assert.equal(deferred.admitted, false)
  if (!deferred.admitted) assert.equal(deferred.reason, 'unavailable_usage_reserve_exhausted')
  active = 0
  coordinator.activityChanged('claude')
  coordinator.activityChanged('claude')
  await coordinator.idle()
  assert.equal(reads, 2)
  assert.equal(wakes.length, 1)
  assert.equal((await records.read(value))?.pacing, undefined)
  coordinator.close()
})

test('a failed refresh keeps its stale reading and enforces the conservative reserve', async () => {
  const records = createOrchestrationStore({ directory: mkdtempSync(join(tmpdir(), 'toucan-pacing-stale-')) })
  const value = record('claude', 'conversation-1', 'D:\\project')
  await put(records, value)
  let fail = false
  const usage = createProviderUsage({
    readers: {
      claude: {
        read: () => {
          if (fail) throw new Error('usage unavailable')
          return { fiveHour: { usedPercent: 10 } }
        }
      }
    },
    ttlMs: 60_000,
    now: () => NOW
  })
  await usage.readProvider('claude', { force: true })
  fail = true
  const coordinator = createOrchestrationPacingCoordinator({
    records,
    usage,
    enabled: true,
    activeTicketSessions: () => 1,
    wake: async () => ({ ok: true }),
    now: () => NOW
  })

  const deferred = await coordinator.admit({ key: value, orchestratorNodeId: 'captain' })
  assert.equal(deferred.admitted, false)
  if (!deferred.admitted) assert.equal(deferred.reason, 'stale_usage_reserve_exhausted')
  assert.equal((await records.read(value))?.pacing?.freshness, 'stale')
  coordinator.close()
})

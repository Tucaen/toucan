import { strict as assert } from 'node:assert'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'
import { createOrchestrationController, orchestrationResetAt } from '../src/main/orchestration-control'
import { createOrchestrationStore } from '../src/main/orchestration-store'
import { applyPlan, parsePlanInput, type OrchestrationRecord } from '../src/shared/orchestration'

const key = { provider: 'claude' as const, conversationId: 'conversation-1' }
const RESET = Date.parse('2026-09-30T15:00:00.000Z')

function record(): OrchestrationRecord {
  const plan = parsePlanInput({
    task: 'Ship pause and resume',
    targetBranch: 'main',
    tickets: [
      { id: '1', title: 'First' },
      { id: '2', title: 'Second' }
    ]
  }).plan!
  const base = applyPlan(undefined, plan, { ...key, projectPath: 'D:\\project' }, '2026-09-30T12:00:00.000Z').record!
  return {
    ...base,
    tickets: base.tickets.map((ticket) => ({
      ...ticket,
      session: { nodeId: `ticket-${ticket.id}`, conversationId: `ticket-conversation-${ticket.id}` }
    }))
  }
}

function harness() {
  const records = createOrchestrationStore({ directory: mkdtempSync(join(tmpdir(), 'toucan-pause-')) })
  const prompts: Array<{ nodeId: string; text: string }> = []
  const killed: string[] = []
  const timers: Array<() => void> = []
  const changes: OrchestrationRecord[] = []
  let now = RESET - 60_000
  const controller = createOrchestrationController({
    records,
    resolve: async (nodeId) => {
      if (nodeId === 'orchestrator') return { key, orchestratorNodeId: 'orchestrator' }
      if (nodeId === 'ticket-1' || nodeId === 'ticket-2') {
        return { key, orchestratorNodeId: 'orchestrator', ticketNodeId: nodeId }
      }
      return null
    },
    readUsage: async () => ({ rejected: true, fiveHour: { usedPercent: 100, resetsAt: RESET } }),
    promptWhenIdle: async (nodeId, text) => {
      prompts.push({ nodeId, text })
      return { ok: true }
    },
    kill: (nodeId) => killed.push(nodeId),
    changed: (next) => changes.push(next),
    now: () => now,
    schedule: (callback) => {
      timers.push(callback)
      return () => undefined
    }
  })
  return { records, controller, prompts, killed, timers, changes, setNow: (value: number) => (now = value) }
}

test('the reset is the last saturated window to clear, or the next reported reset when no window is marked full', () => {
  assert.equal(
    orchestrationResetAt(
      {
        rejected: true,
        fiveHour: { usedPercent: 100, resetsAt: RESET },
        weekly: { usedPercent: 100, resetsAt: RESET + 60_000 }
      },
      RESET - 60_000
    ),
    RESET + 60_000
  )
  assert.equal(
    orchestrationResetAt({ rejected: true, fiveHour: { usedPercent: 90, resetsAt: RESET } }, RESET - 60_000),
    RESET
  )
  assert.equal(
    orchestrationResetAt({ rejected: true, fiveHour: { usedPercent: 100, resetsAt: RESET } }, RESET + 1),
    RESET + 1
  )
})

test('the record is paused before the provider usage read returns', async () => {
  const records = createOrchestrationStore({ directory: mkdtempSync(join(tmpdir(), 'toucan-pause-first-')) })
  await records.update(key, () => ({ value: record(), result: undefined }))
  let finishUsage: ((value: null) => void) | undefined
  let usageStarted!: () => void
  const started = new Promise<void>((resolve) => (usageStarted = resolve))
  const controller = createOrchestrationController({
    records,
    resolve: async () => ({ key, orchestratorNodeId: 'orchestrator', ticketNodeId: 'ticket-1' }),
    readUsage: () => {
      usageStarted()
      return new Promise((resolve) => (finishUsage = resolve))
    },
    promptWhenIdle: async () => ({ ok: true }),
    kill: () => undefined
  })

  controller.observe('ticket-1', {
    type: 'turn_failed',
    turnId: 'turn-1',
    message: 'rate limited',
    errorKind: 'rate_limit'
  })
  await started
  assert.deepEqual((await records.read(key))?.lifecycle, {
    status: 'paused',
    affectedNodeIds: ['ticket-1']
  })
  finishUsage!(null)
  await controller.idle()
})

test('a ticket usage-limit failure durably pauses its orchestration and the reset resumes the ticket and wakes the orchestrator', async () => {
  const { records, controller, prompts, timers, changes, setNow } = harness()
  await records.update(key, () => ({ value: record(), result: undefined }))

  controller.observe('ticket-1', {
    type: 'turn_failed',
    turnId: 'turn-1',
    message: 'Internal error: rate limited',
    errorKind: 'rate_limit'
  })
  await controller.idle()

  const paused = (await records.read(key))!
  assert.deepEqual(paused.lifecycle, { status: 'paused', resetsAt: RESET, affectedNodeIds: ['ticket-1'] })
  assert.deepEqual(
    paused.tickets.map((ticket) => ticket.attempts),
    [0, 0]
  )
  assert.equal(await controller.mayWake('orchestrator'), false)
  assert.equal(timers.length, 1)
  assert.equal(changes.at(-1)?.lifecycle?.status, 'paused')

  setNow(RESET)
  timers.shift()!()
  await controller.idle()

  assert.equal((await records.read(key))!.lifecycle, undefined)
  assert.deepEqual(prompts, [
    { nodeId: 'ticket-1', text: 'Usage limit reset. Continue the interrupted ticket work.' },
    { nodeId: 'orchestrator', text: 'Usage limit reset. Review ticket status and continue the orchestration.' }
  ])
  assert.equal(await controller.mayWake('orchestrator'), true)
})

test('Resume now clears a pause and Stop orchestration kills every ticket session and stays stopped', async () => {
  const { records, controller, prompts, killed } = harness()
  await records.update(key, () => ({ value: record(), result: undefined }))
  controller.observe('ticket-2', {
    type: 'turn_failed',
    turnId: 'turn-2',
    message: 'rate limited',
    errorKind: 'rate_limit'
  })
  await controller.idle()

  const resumed = await controller.resumeNow(key, 'orchestrator')
  assert.equal(resumed?.lifecycle, undefined)
  assert.deepEqual(
    prompts.map(({ nodeId }) => nodeId),
    ['ticket-2', 'orchestrator']
  )

  const stopped = await controller.stop(key, 'orchestrator')
  assert.deepEqual(stopped?.lifecycle, { status: 'stopped' })
  assert.deepEqual(killed, ['ticket-1', 'ticket-2'])
  assert.equal(await controller.resumeNow(key, 'orchestrator'), stopped)
  assert.equal(await controller.mayWake('orchestrator'), false)
})

test('control operations require the named node to own the exact orchestration key', async () => {
  const { records, controller, killed } = harness()
  await records.update(key, () => ({ value: record(), result: undefined }))
  const otherKey = { ...key, conversationId: 'other-conversation' }
  await records.update(otherKey, () => ({
    value: { ...record(), conversationId: otherKey.conversationId },
    result: undefined
  }))

  assert.equal(await controller.state(otherKey, 'orchestrator'), undefined)
  assert.equal(await controller.resumeNow(otherKey, 'orchestrator'), undefined)
  assert.equal(await controller.stop(otherKey, 'orchestrator'), undefined)
  assert.equal(await controller.stop(key, 'ticket-1'), undefined)
  assert.deepEqual(killed, [])
  assert.equal((await records.read(key))?.lifecycle, undefined)
})

test("the orchestrator's own usage-limit failure pauses the run without treating it as an affected ticket", async () => {
  const { records, controller, prompts } = harness()
  await records.update(key, () => ({ value: record(), result: undefined }))
  controller.observe('orchestrator', {
    type: 'turn_failed',
    turnId: 'orchestrator-turn',
    message: 'rate limited',
    errorKind: 'rate_limit'
  })
  await controller.idle()

  assert.deepEqual((await records.read(key))?.lifecycle, {
    status: 'paused',
    resetsAt: RESET,
    affectedNodeIds: []
  })
  await controller.resumeNow(key, 'orchestrator')
  assert.deepEqual(
    prompts.map(({ nodeId }) => nodeId),
    ['orchestrator']
  )
})

test('reading a persisted pause after restart re-arms its reset timer', async () => {
  const { records, controller } = harness()
  const paused = {
    ...record(),
    lifecycle: { status: 'paused' as const, resetsAt: RESET, affectedNodeIds: ['ticket-1'] }
  }
  await records.update(key, () => ({ value: paused, result: undefined }))

  const timers: Array<() => void> = []
  const prompts: string[] = []
  const restarted = createOrchestrationController({
    records,
    resolve: async () => ({ key, orchestratorNodeId: 'orchestrator' }),
    readUsage: async () => null,
    promptWhenIdle: async (nodeId) => {
      prompts.push(nodeId)
      return { ok: true }
    },
    kill: () => undefined,
    now: () => RESET - 1,
    schedule: (callback) => {
      timers.push(callback)
      return () => undefined
    }
  })

  assert.equal((await restarted.state(key, 'orchestrator'))?.lifecycle?.status, 'paused')
  assert.equal(timers.length, 1)
  timers[0]()
  await restarted.idle()
  assert.equal((await records.read(key))?.lifecycle, undefined)
  assert.deepEqual(prompts, ['ticket-1', 'orchestrator'])

  // The first process's controller never needed to observe an event for the durable state to survive.
  await controller.idle()
})

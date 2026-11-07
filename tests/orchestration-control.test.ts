import { strict as assert } from 'node:assert'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'
import {
  createOrchestrationController,
  orchestrationResetAt,
  questionResolvedPrompt
} from '../src/main/orchestration-control'
import { createOrchestrationStore } from '../src/main/orchestration-store'
import {
  addOrchestrationQuestion,
  applyPlan,
  deferOrchestration,
  openOrchestrationQuestions,
  parsePlanInput,
  pauseOrchestration,
  SPAWNS_PER_CHECKPOINT,
  stopOrchestration,
  type OrchestrationRecord
} from '../src/shared/orchestration'

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
      if (nodeId === 'orchestrator') return { provider: 'claude', key, orchestratorNodeId: 'orchestrator' }
      if (nodeId === 'ticket-1' || nodeId === 'ticket-2') {
        return { provider: 'claude', key, orchestratorNodeId: 'orchestrator', ticketNodeId: nodeId }
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

test('proactive pacing does not suppress ticket completion wakes or outcome evidence', async () => {
  const { records, controller } = harness()
  const paced = deferOrchestration(
    record(),
    {
      action: 'spawn',
      state: 'drain',
      reason: 'five_hour_drain_active_ticket_work',
      constrainingWindow: 'five_hour',
      freshness: 'fresh',
      activeTicketSessions: 1
    },
    '2026-09-30T12:30:00.000Z'
  )
  await records.update(key, () => ({ value: paced, result: undefined }))

  assert.equal(await controller.mayWake('orchestrator'), true)
  assert.equal((await records.read(key))?.tickets[0].session?.conversationId, 'ticket-conversation-1')
})

test('the record is paused before the provider usage read returns', async () => {
  const records = createOrchestrationStore({ directory: mkdtempSync(join(tmpdir(), 'toucan-pause-first-')) })
  await records.update(key, () => ({ value: record(), result: undefined }))
  let finishUsage: ((value: null) => void) | undefined
  let usageStarted!: () => void
  const started = new Promise<void>((resolve) => (usageStarted = resolve))
  const controller = createOrchestrationController({
    records,
    resolve: async () => ({
      provider: 'claude',
      key,
      orchestratorNodeId: 'orchestrator',
      ticketNodeId: 'ticket-1'
    }),
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

test('a usage-limit failure reads reset information from the provider of the failing session', async () => {
  const records = createOrchestrationStore({ directory: mkdtempSync(join(tmpdir(), 'toucan-session-provider-')) })
  await records.update(key, () => ({ value: record(), result: undefined }))
  const providers: string[] = []
  const controller = createOrchestrationController({
    records,
    resolve: async () => ({
      key,
      provider: 'codex',
      orchestratorNodeId: 'orchestrator',
      ticketNodeId: 'ticket-1'
    }),
    readUsage: async (provider) => {
      providers.push(provider)
      return null
    },
    promptWhenIdle: async () => ({ ok: true }),
    kill: () => undefined
  })

  controller.observe('ticket-1', {
    type: 'turn_failed',
    turnId: 'turn-1',
    message: 'usage limit reached',
    errorKind: 'usage_limit'
  })
  await controller.idle()

  assert.deepEqual(providers, ['codex'])
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
    { nodeId: 'ticket-1', text: '[Toucan: usage limit reset]\nContinue the interrupted ticket work.' },
    {
      nodeId: 'orchestrator',
      text: '[Toucan: usage limit reset]\nReview ticket status and continue the orchestration.'
    }
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
    resolve: async () => ({ provider: 'claude', key, orchestratorNodeId: 'orchestrator' }),
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

test('Continue at the spawn checkpoint raises the budget once, wakes the orchestrator and keeps the record', async () => {
  const { records, controller, prompts, changes } = harness()
  await records.update(key, () => ({ value: { ...record(), spawnCount: SPAWNS_PER_CHECKPOINT }, result: undefined }))

  // Only the orchestrator node may continue; a ticket session or a stranger is refused.
  assert.equal(await controller.continueSpawns(key, 'ticket-1'), undefined)
  assert.equal(await controller.continueSpawns(key, 'stranger'), undefined)
  assert.equal(prompts.length, 0)

  const continued = await controller.continueSpawns(key, 'orchestrator')
  assert.equal(continued?.spawnBudget, 2 * SPAWNS_PER_CHECKPOINT)
  assert.equal(continued?.spawnCount, SPAWNS_PER_CHECKPOINT)
  assert.deepEqual(
    continued?.tickets.map((ticket) => ticket.session?.conversationId),
    ['ticket-conversation-1', 'ticket-conversation-2']
  )
  assert.equal(changes.at(-1)?.spawnBudget, 2 * SPAWNS_PER_CHECKPOINT)
  await controller.idle()
  assert.deepEqual(
    prompts.map((prompt) => prompt.nodeId),
    ['orchestrator']
  )
  assert.match(
    prompts[0].text,
    /^\[Toucan: user pressed Continue \(\+20\)\]\nThe spawn budget is now 40 \(20 used\).*retry the spawn/
  )
  assert.equal((await records.read(key))?.spawnBudget, 2 * SPAWNS_PER_CHECKPOINT)

  // A second press on a stale button finds nothing to continue: no extra budget, no extra wake.
  const again = await controller.continueSpawns(key, 'orchestrator')
  assert.equal(again?.spawnBudget, 2 * SPAWNS_PER_CHECKPOINT)
  await controller.idle()
  assert.equal(prompts.length, 1)
})

test('Continue below the budget changes nothing and wakes nobody', async () => {
  const { records, controller, prompts, changes } = harness()
  await records.update(key, () => ({ value: record(), result: undefined }))
  const unchanged = await controller.continueSpawns(key, 'orchestrator')
  assert.equal(unchanged?.spawnBudget, undefined)
  await controller.idle()
  assert.equal(prompts.length, 0)
  assert.equal(changes.length, 0)
})

test('the human resolving a pinned question records it, wakes the orchestrator once and names the note (#2)', async () => {
  const { records, controller, prompts, changes } = harness()
  const asked = addOrchestrationQuestion(record(), { ticketId: '1', markdown: 'Left or right?' }, 't1').record!
  await records.update(key, () => ({
    value: addOrchestrationQuestion(asked, { markdown: 'Ship today?' }, 't1').record!,
    result: undefined
  }))

  // Only the orchestrator node's own controls may resolve; a ticket session or a stranger is refused.
  assert.equal(await controller.resolveQuestion(key, 'ticket-1', 'Q1'), undefined)
  assert.equal(await controller.resolveQuestion(key, 'stranger', 'Q1'), undefined)

  const resolved = await controller.resolveQuestion(key, 'orchestrator', 'Q1', 'the left one')
  const q1 = resolved?.openQuestions?.find((question) => question.id === 'Q1')
  assert.equal(q1?.resolution, 'the left one')
  assert.equal(q1?.resolvedAt, new Date(RESET - 60_000).toISOString())
  assert.deepEqual(
    openOrchestrationQuestions((await records.read(key))!).map((question) => question.id),
    ['Q2']
  )
  assert.equal(changes.length, 1)
  await controller.idle()
  assert.deepEqual(
    prompts.map((prompt) => prompt.nodeId),
    ['orchestrator']
  )
  assert.equal(prompts[0].text, questionResolvedPrompt(q1!))
  assert.match(prompts[0].text, /^\[Toucan: user resolved Q1\]\n/)
  assert.match(prompts[0].text, /ticket 1/)
  // A question without options says nothing about relaying; one with options tells the orchestrator to pass the pick on.
  assert.doesNotMatch(prompts[0].text, /followup/)
  const withOptions = { ...q1!, options: [{ label: 'Left' }], resolution: 'Answer: Left' }
  assert.match(
    questionResolvedPrompt(withOptions),
    /Their note: Answer: Left[\s\S]*ticket 1's session still waits[\s\S]*`followup`/
  )
  assert.doesNotMatch(questionResolvedPrompt({ ...withOptions, ticketId: undefined }), /followup/)
  assert.match(prompts[0].text, /the left one/)

  // Without a note the wake says so; a stale second press or an unknown id wakes nobody.
  await controller.resolveQuestion(key, 'orchestrator', 'Q2')
  await controller.idle()
  assert.match(prompts[1].text, /^\[Toucan: user resolved Q2\]\n.*no note/s)
  const stale = await controller.resolveQuestion(key, 'orchestrator', 'Q1', 'again')
  assert.equal(stale?.openQuestions?.find((question) => question.id === 'Q1')?.resolution, 'the left one')
  assert.equal((await controller.resolveQuestion(key, 'orchestrator', 'Q9'))?.conversationId, key.conversationId)
  await controller.idle()
  assert.equal(prompts.length, 2)
  assert.equal(changes.length, 2)
})

test('a resolve on a paused or stopped orchestration is recorded but wakes nobody (#2)', async () => {
  const { records, controller, prompts } = harness()
  let asked = addOrchestrationQuestion(record(), { markdown: 'a' }, 't1').record!
  asked = addOrchestrationQuestion(asked, { markdown: 'b' }, 't1').record!
  await records.update(key, () => ({ value: pauseOrchestration(asked, undefined, undefined, 't2'), result: undefined }))
  const paused = await controller.resolveQuestion(key, 'orchestrator', 'Q1', 'note')
  assert.equal(paused?.openQuestions?.[0]?.resolution, 'note')
  await records.update(key, (current) => ({ value: stopOrchestration(current!, 't3'), result: undefined }))
  assert.ok((await controller.resolveQuestion(key, 'orchestrator', 'Q2'))?.openQuestions?.[1]?.resolvedAt)
  await controller.idle()
  assert.deepEqual(prompts, [])
})

test('resolves the orchestrator could not take yet all arrive at its next ready, once each (#2)', async () => {
  const records = createOrchestrationStore({ directory: mkdtempSync(join(tmpdir(), 'toucan-resolve-held-')) })
  const prompts: string[] = []
  let ready = false
  const controller = createOrchestrationController({
    records,
    resolve: async () => ({ provider: 'claude', key, orchestratorNodeId: 'orchestrator' }),
    readUsage: async () => null,
    promptWhenIdle: async (_nodeId, text) => {
      if (!ready) return { ok: false, message: 'not ready', undelivered: true }
      prompts.push(text)
      return { ok: true }
    },
    kill: () => undefined
  })
  let asked = addOrchestrationQuestion(record(), { markdown: 'a' }, 't1').record!
  asked = addOrchestrationQuestion(asked, { markdown: 'b' }, 't1').record!
  await records.update(key, () => ({ value: asked, result: undefined }))
  await controller.resolveQuestion(key, 'orchestrator', 'Q1')
  await controller.resolveQuestion(key, 'orchestrator', 'Q2')
  await controller.idle()
  // Not ready yet: the retry is refused again and must not double the held text.
  controller.observe('orchestrator', { type: 'status', status: 'ready' })
  await controller.idle()
  ready = true
  controller.observe('orchestrator', { type: 'status', status: 'ready' })
  await controller.idle()
  assert.equal(prompts.length, 1)
  assert.equal((prompts[0].match(/\[Toucan: user resolved Q1\]/g) ?? []).length, 1)
  assert.equal((prompts[0].match(/\[Toucan: user resolved Q2\]/g) ?? []).length, 1)
})

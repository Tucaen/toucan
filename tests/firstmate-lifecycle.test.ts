import { strict as assert } from 'node:assert'
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { FirstMateLifecycleStatus, FirstMateLifecycleTask } from '../src/shared/firstmate'
import { firstMateTaskContextMetadata, type FirstMateTaskContext } from '../src/shared/firstmate-task-context'
import { createFirstMateLifecycleCoordinator } from '../src/main/firstmate-lifecycle-coordinator'
import {
  firstMateLifecycleFromFiles,
  firstMateValidationDispatchId,
  noMistakesContinuation,
  readFirstMateLifecycle,
  recordFirstMateLifecycle,
  type FirstMateLifecycleRecord
} from '../src/main/firstmate-lifecycle'

const alphaCodexContext: FirstMateTaskContext = {
  version: 1,
  project: {
    adeProjectId: 'alpha',
    registryName: 'api-alpha',
    windowsPath: 'D:\\Development\\alpha\\api',
    wslPath: '/mnt/d/Development/alpha/api',
    mode: 'no-mistakes',
    autonomy: false
  },
  validator: { agent: 'codex', model: 'gpt-5.6-sol' }
}

function taskHome(context: FirstMateTaskContext = alphaCodexContext): { home: string; statusPath: string } {
  const home = mkdtempSync(join(tmpdir(), 'ade-firstmate-lifecycle-'))
  const state = join(home, 'state')
  const config = join(home, 'config')
  mkdirSync(state, { recursive: true })
  mkdirSync(config, { recursive: true })
  writeFileSync(join(config, 'ade-runtime.json'), JSON.stringify({
    version: 1,
    host: { kind: 'ade-app', supervisor: 'app-native', terminalTarget: false },
    validator: {
      agent: 'codex',
      model: 'gpt-5.6-sol',
      nmHome: join(home, 'no-mistakes'),
      agentHome: join(home, 'codex')
    }
  }))
  writeFileSync(join(state, 'resize.meta'), [
    'worktree=/tmp/resize',
    `project=${context.project.wslPath}`,
    'harness=codex',
    'kind=ship',
    'mode=no-mistakes',
    'yolo=off',
    'model=gpt-5.6-sol',
    firstMateTaskContextMetadata(context)
  ].join('\n'))
  const statusPath = join(state, 'resize.status')
  writeFileSync(statusPath, 'done: committed resizable panel\n')
  return { home, statusPath }
}

interface JournalRuntimeOptions {
  continueValidation?(taskId: string, dispatchId: string): { ok: boolean; message?: string }
  beforeRecord?(taskId: string, record: FirstMateLifecycleRecord): void
}

interface JournalRuntime {
  runtime: {
    lifecycle(): Promise<FirstMateLifecycleStatus>
    continueValidation(taskId: string, dispatchId: string): Promise<{ ok: boolean; message?: string }>
    recordLifecycle(taskId: string, record: FirstMateLifecycleRecord): Promise<void>
  }
  continuations: Array<{ taskId: string; dispatchId: string }>
}

/**
 * A runtime backed by the real on-disk journal, so a fresh coordinator over the same
 * home reproduces an ADE restart: durable state survives, in-memory state does not.
 * No coding-agent binary is involved; the continuation is a counted stub.
 */
function journalRuntime(home: string, options: JournalRuntimeOptions = {}): JournalRuntime {
  const continuations: Array<{ taskId: string; dispatchId: string }> = []
  return {
    continuations,
    runtime: {
      lifecycle: () => readFirstMateLifecycle(home),
      async continueValidation(taskId: string, dispatchId: string) {
        continuations.push({ taskId, dispatchId })
        return options.continueValidation?.(taskId, dispatchId) ?? { ok: true }
      },
      async recordLifecycle(taskId: string, record: FirstMateLifecycleRecord) {
        options.beforeRecord?.(taskId, record)
        await recordFirstMateLifecycle(home, taskId, record)
      }
    }
  }
}

function throwOnAcknowledgement(message: string) {
  return (_taskId: string, record: FirstMateLifecycleRecord): void => {
    if (record.dispatch?.status === 'acknowledged') throw new Error(message)
  }
}

function coordinatorFor(runtime: JournalRuntime['runtime'], maxDispatchAttempts?: number) {
  return createFirstMateLifecycleCoordinator({
    runtime,
    now: () => new Date('2026-08-14T18:00:00.000Z'),
    wakeCaptain: async () => ({ ok: true }),
    ...(maxDispatchAttempts ? { maxDispatchAttempts } : {})
  })
}

async function onlyTask(home: string): Promise<FirstMateLifecycleTask> {
  const lifecycle = await readFirstMateLifecycle(home)
  assert.equal(lifecycle.tasks.length, 1)
  return lifecycle.tasks[0]!
}

test('durably reconciles a no-mistakes task from implementation through validation and PR readiness', async () => {
  const { home, statusPath } = taskHome()

  let lifecycle = await readFirstMateLifecycle(home)
  assert.deepEqual(lifecycle.validator, {
    agent: 'codex',
    model: 'gpt-5.6-sol',
    configSource: 'ade-runtime'
  })
  assert.equal(lifecycle.tasks[0]?.stage, 'implemented')
  assert.equal(lifecycle.tasks[0]?.nextAction, 'start-validation')
  assert.equal(lifecycle.tasks[0]?.worktree, '/tmp/resize')
  assert.deepEqual(lifecycle.tasks[0]?.context, alphaCodexContext)

  const implemented = lifecycle.tasks[0]!
  await recordFirstMateLifecycle(home, implemented.id, {
    stage: 'validating',
    detail: 'ADE continued validation.',
    statusHash: implemented.statusHash,
    nextAction: 'await-validation',
    updatedAt: '2026-08-14T18:00:00.000Z'
  })

  lifecycle = await readFirstMateLifecycle(home)
  assert.equal(lifecycle.tasks[0]?.stage, 'validating', 'reload must retain the next validation action')

  appendFileSync(statusPath, 'needs-decision: [key=review] choose whether to change product behavior\n')
  lifecycle = await readFirstMateLifecycle(home)
  assert.equal(lifecycle.tasks[0]?.stage, 'decision')
  assert.equal(lifecycle.tasks[0]?.nextAction, 'await-decision')

  appendFileSync(statusPath, 'blocked: [key=review] credentials are required\n')
  lifecycle = await readFirstMateLifecycle(home)
  assert.equal(lifecycle.tasks[0]?.stage, 'blocked')
  assert.equal(lifecycle.tasks[0]?.nextAction, 'await-help')

  appendFileSync(statusPath, 'resolved: [key=review] credentials supplied by Firstmate\n')
  lifecycle = await readFirstMateLifecycle(home)
  assert.equal(lifecycle.tasks[0]?.stage, 'validating')

  appendFileSync(statusPath, 'done: PR https://github.com/Tucaen/ade/pull/99 checks green\n')
  lifecycle = await readFirstMateLifecycle(home)
  assert.equal(lifecycle.tasks[0]?.stage, 'pr-ready')
  assert.equal(lifecycle.tasks[0]?.prUrl, 'https://github.com/Tucaen/ade/pull/99')
  assert.equal(lifecycle.tasks[0]?.nextAction, 'review-pr')
})

test('blocks a task whose spawn metadata drifted from its pinned external project', () => {
  const lifecycle = firstMateLifecycleFromFiles({
    tasks: [{
      id: 'resize',
      meta: [
        'kind=ship',
        'mode=no-mistakes',
        'yolo=off',
        'project=/mnt/d/Development/beta/api',
        'worktree=/home/tucaen/.treehouse/beta/resize',
        'harness=codex',
        'model=gpt-5.6-sol',
        firstMateTaskContextMetadata(alphaCodexContext)
      ].join('\n'),
      status: 'done: committed implementation\n'
    }]
  })

  assert.equal(lifecycle.tasks[0]?.stage, 'blocked')
  assert.equal(lifecycle.tasks[0]?.nextAction, 'await-help')
  assert.match(lifecycle.tasks[0]?.detail ?? '', /project.*beta.*alpha/i)
  assert.equal(lifecycle.tasks[0]?.context?.project.adeProjectId, 'alpha')
})

test('blocks a task whose declared ADE context is malformed instead of treating it as legacy metadata', () => {
  const lifecycle = firstMateLifecycleFromFiles({
    tasks: [{
      id: 'resize',
      meta: [
        'kind=ship',
        'mode=no-mistakes',
        'project=/mnt/d/Development/alpha/api',
        'worktree=/home/tucaen/.treehouse/alpha/resize',
        'harness=codex',
        'ade_task_context=%7Bnot-json'
      ].join('\n'),
      status: 'done: committed implementation\n'
    }]
  })

  assert.equal(lifecycle.tasks[0]?.stage, 'blocked')
  assert.match(lifecycle.tasks[0]?.detail ?? '', /task context.*malformed/i)
})

test('derives a validation dispatch identity that survives ADE and FirstMate restarts', () => {
  const first = firstMateValidationDispatchId('resize', 'a1b2c3', 1)

  assert.equal(first, firstMateValidationDispatchId('resize', 'a1b2c3', 1))
  assert.notEqual(first, firstMateValidationDispatchId('resize', 'a1b2c3', 2))
  assert.notEqual(first, firstMateValidationDispatchId('resize', 'd4e5f6', 1))
  assert.notEqual(first, firstMateValidationDispatchId('panel', 'a1b2c3', 1))
  assert.match(first, /^[a-zA-Z0-9._-]+$/, 'the identity travels as a command argument')
})

test('carries the dispatch identity into the continuation so FirstMate can deduplicate it', () => {
  const continuation = noMistakesContinuation('codex', '/home/config/ade-runtime.json', 'resize.a1b2c3.1')

  assert.match(continuation, /^\$no-mistakes/)
  assert.match(continuation, /resize\.a1b2c3\.1/)
  assert.match(continuation, /idempotenc/i)
  assert.match(continuation, /do not start a second/i)
})

function implementedTask(): FirstMateLifecycleTask {
  return {
    id: 'resize',
    mode: 'no-mistakes',
    stage: 'implemented',
    detail: 'committed resizable panel',
    statusHash: 'implementation-1',
    nextAction: 'start-validation'
  }
}

test('continues a committed worker directly into validation exactly once and wakes the app-hosted captain', async () => {
  let task = implementedTask()
  const records: FirstMateLifecycleRecord[] = []
  const continuations: string[] = []
  const wakes: string[] = []
  const runtime = {
    async lifecycle(): Promise<FirstMateLifecycleStatus> {
      return { supervision: 'app-native', tasks: [task] }
    },
    async continueValidation(taskId: string, dispatchId: string): Promise<{ ok: boolean }> {
      continuations.push(`${taskId}@${dispatchId}`)
      return { ok: true }
    },
    async recordLifecycle(_taskId: string, record: FirstMateLifecycleRecord): Promise<void> {
      records.push(record)
      task = { ...task, ...record }
    }
  }
  const coordinator = createFirstMateLifecycleCoordinator({
    runtime,
    now: () => new Date('2026-08-14T18:00:00.000Z'),
    wakeCaptain: async (message) => {
      wakes.push(message)
      return { ok: true }
    }
  })

  await coordinator.poll()
  await coordinator.poll()

  const dispatchId = firstMateValidationDispatchId('resize', 'implementation-1', 1)
  assert.deepEqual(continuations, [`resize@${dispatchId}`])
  assert.deepEqual(records.map((record) => [record.stage, record.nextAction, record.dispatch?.status]), [
    ['dispatching', 'await-dispatch', 'claimed'],
    ['validating', 'await-validation', 'acknowledged']
  ])
  assert.equal(
    records[0]?.dispatch?.id,
    dispatchId,
    'the intent to dispatch is durably recorded before the continuation runs'
  )
  assert.equal(task.stage, 'validating')
  assert.equal(wakes.length, 1)
  assert.match(wakes[0], /resize=validating/)
  assert.match(wakes[0], /ADE is the captain conversation host/)
})

test('makes a failed validation continuation durable and visible instead of claiming progress', async () => {
  let task = implementedTask()
  const coordinator = createFirstMateLifecycleCoordinator({
    runtime: {
      async lifecycle(): Promise<FirstMateLifecycleStatus> {
        return { supervision: 'app-native', tasks: [task] }
      },
      async continueValidation(): Promise<{ ok: boolean; message: string }> {
        return { ok: false, message: 'task endpoint is unavailable' }
      },
      async recordLifecycle(_taskId: string, record: FirstMateLifecycleRecord): Promise<void> {
        task = { ...task, ...record }
      }
    },
    maxDispatchAttempts: 1,
    wakeCaptain: async () => ({ ok: true })
  })

  await coordinator.poll()

  assert.equal(task.stage, 'implemented', 'a rejection is durably retryable before it is judged')
  assert.equal(task.dispatch?.status, 'retryable')
  assert.equal(task.detail, 'task endpoint is unavailable')

  await coordinator.poll()

  assert.equal(task.stage, 'blocked')
  assert.equal(task.nextAction, 'await-help')
  assert.equal(task.detail, 'task endpoint is unavailable')
})

test('retries reconciliation after a transient persistence failure without losing the next action', async () => {
  let task = implementedTask()
  let recordAttempts = 0
  let continuations = 0
  const wakes: string[] = []
  const coordinator = createFirstMateLifecycleCoordinator({
    runtime: {
      async lifecycle(): Promise<FirstMateLifecycleStatus> {
        return { supervision: 'app-native', tasks: [task] }
      },
      async continueValidation(): Promise<{ ok: boolean }> {
        continuations += 1
        return { ok: true }
      },
      async recordLifecycle(_taskId: string, record: FirstMateLifecycleRecord): Promise<void> {
        recordAttempts += 1
        if (recordAttempts === 1) throw new Error('temporary journal lock')
        task = { ...task, ...record }
      }
    },
    wakeCaptain: async (message) => {
      wakes.push(message)
      return { ok: true }
    }
  })

  await coordinator.poll()
  await coordinator.poll()

  assert.equal(task.stage, 'validating')
  assert.equal(continuations, 1)
  assert.match(wakes[0], /Lifecycle reconciliation failed: temporary journal lock/)
})

test('never repeats a continuation that succeeded before ADE crashed on the following lifecycle update', async () => {
  const { home } = taskHome()
  const crashing = journalRuntime(home, {
    beforeRecord: throwOnAcknowledgement('ADE crashed before the lifecycle update')
  })

  await coordinatorFor(crashing.runtime).poll()

  assert.equal(crashing.continuations.length, 1, 'the continuation must run once before the crash')
  const claimed = await onlyTask(home)
  assert.equal(claimed.stage, 'dispatching')
  assert.equal(claimed.dispatch?.status, 'claimed')
  assert.equal(claimed.dispatch?.id, crashing.continuations[0]!.dispatchId)

  const restarted = journalRuntime(home)
  const coordinator = coordinatorFor(restarted.runtime)
  await coordinator.poll()
  await coordinator.poll()

  assert.deepEqual(restarted.continuations, [], 'a restart must not repeat a claimed dispatch')
  const recovered = await onlyTask(home)
  assert.equal(recovered.stage, 'blocked')
  assert.equal(recovered.nextAction, 'await-help')
  assert.equal(recovered.dispatch?.status, 'unresolved')
  assert.equal(recovered.dispatch?.id, crashing.continuations[0]!.dispatchId)
  assert.match(
    recovered.detail,
    /Release the dispatch to resend the same identity/,
    'a blocked dispatch must name the way out of it'
  )
})

test('re-persists an acknowledged dispatch after a journal failure without dispatching again', async () => {
  const { home } = taskHome()
  let failedOnce = false
  const harness = journalRuntime(home, {
    beforeRecord: (_taskId, record) => {
      if (record.dispatch?.status !== 'acknowledged' || failedOnce) return
      failedOnce = true
      throw new Error('temporary journal lock')
    }
  })
  const coordinator = coordinatorFor(harness.runtime)

  await coordinator.poll()
  await coordinator.poll()

  assert.equal(harness.continuations.length, 1)
  const task = await onlyTask(home)
  assert.equal(task.stage, 'validating')
  assert.equal(task.nextAction, 'await-validation')
  assert.equal(task.dispatch?.status, 'acknowledged')
})

test('keeps a task safely retryable when the dispatch claim cannot be persisted', async () => {
  const { home } = taskHome()
  let claimAttempts = 0
  const harness = journalRuntime(home, {
    beforeRecord: (_taskId, record) => {
      if (record.dispatch?.status !== 'claimed') return
      claimAttempts += 1
      if (claimAttempts === 1) throw new Error('temporary journal lock')
    }
  })
  const coordinator = coordinatorFor(harness.runtime)

  await coordinator.poll()

  assert.deepEqual(harness.continuations, [], 'nothing may be dispatched without a durable claim')
  const pending = await onlyTask(home)
  assert.equal(pending.stage, 'implemented')
  assert.equal(pending.nextAction, 'start-validation')

  await coordinator.poll()

  assert.equal(harness.continuations.length, 1)
  const validating = await onlyTask(home)
  assert.equal(validating.stage, 'validating')
  assert.equal(validating.dispatch?.status, 'acknowledged')
})

test('releases a rejected dispatch for a fresh attempt and blocks once the budget is spent', async () => {
  const { home } = taskHome()
  const harness = journalRuntime(home, {
    continueValidation: () => ({ ok: false, message: 'task endpoint is unavailable' })
  })
  const coordinator = coordinatorFor(harness.runtime, 2)

  await coordinator.poll()

  const retryable = await onlyTask(home)
  assert.equal(retryable.stage, 'implemented', 'a rejected dispatch stays actionable')
  assert.equal(retryable.nextAction, 'start-validation')
  assert.equal(retryable.dispatch?.status, 'retryable')
  assert.equal(retryable.dispatch?.attempt, 1)

  await coordinator.poll()

  assert.deepEqual(
    harness.continuations.map((call) => call.dispatchId),
    [
      firstMateValidationDispatchId('resize', retryable.statusHash, 1),
      firstMateValidationDispatchId('resize', retryable.statusHash, 2)
    ],
    'each attempt of a rejected dispatch carries its own identity'
  )

  await coordinator.poll()

  const blocked = await onlyTask(home)
  assert.equal(blocked.stage, 'blocked')
  assert.equal(blocked.nextAction, 'await-help')
  assert.equal(blocked.detail, 'task endpoint is unavailable')
  assert.equal(harness.continuations.length, 2, 'the attempt budget stops further dispatches')

  await coordinator.poll()

  assert.equal(harness.continuations.length, 2, 'a blocked task is not dispatched again')
})

test('blocks a claimed dispatch as recoverable when the continuation itself throws', async () => {
  const { home } = taskHome()
  const harness = journalRuntime(home, {
    continueValidation: () => { throw new Error('wsl.exe terminated unexpectedly') }
  })
  const coordinator = coordinatorFor(harness.runtime)

  await coordinator.poll()
  await coordinator.poll()

  assert.equal(harness.continuations.length, 1, 'an unknown outcome is never re-sent')
  const task = await onlyTask(home)
  assert.equal(task.stage, 'blocked')
  assert.equal(task.nextAction, 'await-help')
  assert.equal(task.dispatch?.status, 'unresolved')
  assert.match(task.detail, /wsl\.exe terminated unexpectedly/)
})

test('resolves a claimed dispatch when FirstMate itself reports validation after a restart', async () => {
  const { home, statusPath } = taskHome()
  const crashing = journalRuntime(home, {
    beforeRecord: throwOnAcknowledgement('ADE crashed before the lifecycle update')
  })

  await coordinatorFor(crashing.runtime).poll()
  assert.equal(crashing.continuations.length, 1)

  appendFileSync(statusPath, 'working: no-mistakes validation is running\n')

  const restarted = journalRuntime(home)
  await coordinatorFor(restarted.runtime).poll()

  assert.deepEqual(restarted.continuations, [], 'FirstMate-reported validation acknowledges the claim')
  const task = await onlyTask(home)
  assert.equal(task.stage, 'validating')
  assert.equal(task.nextAction, 'await-validation')
})

test('keeps an unfinished dispatch when a new status line rehashes the task', async () => {
  const { home, statusPath } = taskHome()
  const crashing = journalRuntime(home, {
    beforeRecord: throwOnAcknowledgement('ADE crashed before the lifecycle update')
  })

  await coordinatorFor(crashing.runtime).poll()
  const claimedId = crashing.continuations[0]!.dispatchId

  // FirstMate reports another implementation. The status hash changes, but the outstanding claim
  // must survive it: this line is not evidence that the earlier continuation never arrived.
  appendFileSync(statusPath, 'done: committed a follow-up fix\n')

  const restarted = journalRuntime(home)
  const coordinator = coordinatorFor(restarted.runtime)
  await coordinator.poll()
  await coordinator.poll()

  assert.deepEqual(restarted.continuations, [], 'a rehashed task must not re-dispatch a live claim')
  const task = await onlyTask(home)
  assert.equal(task.stage, 'blocked')
  assert.equal(task.dispatch?.status, 'unresolved')
  assert.equal(task.dispatch?.id, claimedId)
})

test('resends the recorded identity when an operator releases an unresolved dispatch', async () => {
  const { home } = taskHome()
  const crashing = journalRuntime(home, {
    beforeRecord: throwOnAcknowledgement('ADE crashed before the lifecycle update')
  })

  await coordinatorFor(crashing.runtime).poll()
  const claimedId = crashing.continuations[0]!.dispatchId

  const restarted = journalRuntime(home)
  const coordinator = coordinatorFor(restarted.runtime)
  await coordinator.poll()

  const unresolved = await onlyTask(home)
  assert.equal(unresolved.dispatch?.status, 'unresolved')

  assert.deepEqual(await coordinator.releaseDispatch('resize'), { ok: true })
  const released = await onlyTask(home)
  assert.equal(released.stage, 'implemented', 'a released dispatch is actionable again')
  assert.equal(released.nextAction, 'start-validation')
  assert.equal(released.dispatch?.status, 'released')

  await coordinator.poll()

  assert.deepEqual(
    restarted.continuations.map((call) => call.dispatchId),
    [claimedId],
    'the resend reuses the identity FirstMate may already have seen'
  )
  const validating = await onlyTask(home)
  assert.equal(validating.stage, 'validating')
  assert.equal(validating.dispatch?.status, 'acknowledged')
})

test('refuses to release a dispatch that is not unresolved', async () => {
  const { home } = taskHome()
  const harness = journalRuntime(home)
  const coordinator = coordinatorFor(harness.runtime)

  const missing = await coordinator.releaseDispatch('absent')
  assert.equal(missing.ok, false)
  assert.match(missing.message ?? '', /no durable state/i)

  await coordinator.poll()

  const validating = await coordinator.releaseDispatch('resize')
  assert.equal(validating.ok, false)
  assert.match(validating.message ?? '', /no unresolved validation dispatch/i)
  assert.equal(harness.continuations.length, 1)
})

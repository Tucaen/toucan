import { strict as assert } from 'node:assert'
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { FirstMateLifecycleStatus, FirstMateLifecycleTask } from '../src/shared/firstmate'
import { createFirstMateLifecycleCoordinator } from '../src/main/firstmate-lifecycle-coordinator'
import {
  readFirstMateLifecycle,
  recordFirstMateLifecycle,
  type FirstMateLifecycleRecord
} from '../src/main/firstmate-lifecycle'

function taskHome(): { home: string; statusPath: string } {
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
    'harness=codex',
    'kind=ship',
    'mode=no-mistakes'
  ].join('\n'))
  const statusPath = join(state, 'resize.status')
  writeFileSync(statusPath, 'done: committed resizable panel\n')
  return { home, statusPath }
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
    async continueValidation(taskId: string): Promise<{ ok: boolean }> {
      continuations.push(taskId)
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

  assert.deepEqual(continuations, ['resize'])
  assert.deepEqual(records.map((record) => [record.stage, record.nextAction]), [
    ['implemented', 'start-validation'],
    ['validating', 'await-validation']
  ])
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
    wakeCaptain: async () => ({ ok: true })
  })

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

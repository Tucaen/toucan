import { strict as assert } from 'node:assert'
import { appendFileSync, mkdirSync, mkdtempSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type {
  FirstMateLifecycleStatus,
  FirstMateLifecycleTask,
  FirstMatePullRequestCheck,
  FirstMateValidationDelivery
} from '../src/shared/firstmate'
import { firstMateTaskContextMetadata, type FirstMateTaskContext } from '../src/shared/firstmate-task-context'
import { createFirstMateLifecycleCoordinator } from '../src/main/firstmate-lifecycle-coordinator'
import {
  firstMateLifecycleFromFiles,
  firstMatePrResolvedRecord,
  firstMateValidationDispatchId,
  noMistakesContinuation,
  type FirstMateLifecycleRecord,
  type FirstMateRawTask
} from '../src/main/firstmate-lifecycle'
import type { FirstMateWorktreeProvenance } from '../src/main/firstmate-worktree-provenance'
import { createGitCrew, gitProvenance } from './firstmate-git-crew'
import {
  readFirstMateLifecycle,
  readFirstMateLifecycleFiles,
  recordFirstMateLifecycle
} from './firstmate-journal-home'

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
  continueValidation?(taskId: string, dispatchId: string): FirstMateValidationDelivery
  beforeRecord?(taskId: string, record: FirstMateLifecycleRecord): void
}

interface JournalRuntime {
  runtime: {
    lifecycle(): Promise<FirstMateLifecycleStatus>
    continueValidation(taskId: string, dispatchId: string): Promise<FirstMateValidationDelivery>
    recordLifecycle(taskId: string, record: FirstMateLifecycleRecord): Promise<void>
  }
  continuations: Array<{ taskId: string; dispatchId: string }>
}

/**
 * A runtime backed by an on-disk journal, so a fresh coordinator over the same home
 * reproduces an ADE restart: durable state survives, in-memory state does not.
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
        return options.continueValidation?.(taskId, dispatchId) ?? { outcome: 'acknowledged' }
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
    dispatch: { id: 'resize.validation.1', status: 'acknowledged', attempt: 1 },
    updatedAt: '2026-08-14T18:00:00.000Z'
  })

  lifecycle = await readFirstMateLifecycle(home)
  assert.equal(lifecycle.tasks[0]?.stage, 'validating', 'reload must retain the next validation action')

  appendFileSync(statusPath, 'needs-decision: [key=review] choose whether to change product behavior\n')
  lifecycle = await readFirstMateLifecycle(home)
  assert.equal(lifecycle.tasks[0]?.stage, 'decision')
  assert.equal(lifecycle.tasks[0]?.nextAction, 'await-decision')
  assert.equal(lifecycle.tasks[0]?.dispatch?.status, 'acknowledged')

  appendFileSync(statusPath, 'blocked: [key=review] credentials are required\n')
  lifecycle = await readFirstMateLifecycle(home)
  assert.equal(lifecycle.tasks[0]?.stage, 'blocked')
  assert.equal(lifecycle.tasks[0]?.nextAction, 'await-help')
  assert.equal(lifecycle.tasks[0]?.dispatch?.status, 'acknowledged')

  appendFileSync(statusPath, 'resolved: [key=review] credentials supplied by Firstmate\n')
  lifecycle = await readFirstMateLifecycle(home)
  assert.equal(lifecycle.tasks[0]?.stage, 'validating')

  appendFileSync(statusPath, 'done: PR https://github.com/Tucaen/ade/pull/99 checks green\n')
  lifecycle = await readFirstMateLifecycle(home)
  assert.equal(lifecycle.tasks[0]?.stage, 'pr-ready')
  assert.equal(lifecycle.tasks[0]?.prUrl, 'https://github.com/Tucaen/ade/pull/99')
  assert.equal(lifecycle.tasks[0]?.nextAction, 'review-pr')
})

test('durable history converges across restart, replay, and out-of-order evidence', async () => {
  const { home } = taskHome()
  const observed = await onlyTask(home)
  const base = {
    stage: 'validating' as const, detail: 'Validation started', statusHash: observed.statusHash,
    nextAction: 'await-validation' as const
  }
  await recordFirstMateLifecycle(home, 'resize', {
    ...base, updatedAt: '2026-08-24T10:02:00.000Z',
    history: [{ id: 'new', occurredAt: '2026-08-24T10:02:00.000Z', source: 'ade-reconciliation', stage: 'validating', detail: 'Validation started' }]
  })
  await recordFirstMateLifecycle(home, 'resize', {
    stage: 'implemented', detail: 'Older replay', statusHash: observed.statusHash, updatedAt: '2026-08-24T10:01:00.000Z',
    history: [{ id: 'old', occurredAt: '2026-08-24T10:01:00.000Z', source: 'firstmate-status', stage: 'implemented', detail: 'Implementation committed' }]
  })
  await recordFirstMateLifecycle(home, 'resize', {
    ...base, updatedAt: '2026-08-24T10:02:00.000Z',
    history: [{ id: 'new', occurredAt: '2026-08-24T10:02:00.000Z', source: 'ade-reconciliation', stage: 'validating', detail: 'Validation started' }]
  })
  const restarted = await readFirstMateLifecycle(home)
  assert.equal(restarted.tasks[0]?.stage, 'validating')
  assert.deepEqual(restarted.tasks[0]?.history?.map((event) => event.id), ['old', 'new'])
})

test('duplicate normalized FirstMate evidence has one correctly attributed history event', async () => {
  const { home, statusPath } = taskHome()
  appendFileSync(statusPath, 'needs-decision: [key=review] choose product behavior\n')
  const harness = journalRuntime(home)
  const coordinator = coordinatorFor(harness.runtime)
  await coordinator.poll()
  appendFileSync(statusPath, 'needs-decision:   [key=review]   choose product behavior\n')
  await coordinator.poll()
  const task = await onlyTask(home)
  const decisions = task.history?.filter((event) => event.stage === 'decision') ?? []
  assert.equal(decisions.length, 1)
  assert.equal(decisions[0]?.source, 'firstmate-status')
})

test('duplicate implementation evidence becomes indeterminate after acknowledgement', async () => {
  const { home, statusPath } = taskHome()
  const harness = journalRuntime(home)
  const coordinator = coordinatorFor(harness.runtime)
  await coordinator.poll()
  appendFileSync(statusPath, 'done:   committed resizable panel\n')
  await coordinator.poll()
  assert.equal(harness.continuations.length, 1)
  const task = await onlyTask(home)
  assert.equal(task.stage, 'blocked')
  assert.equal(task.terminalOutcome, 'indeterminate')
  assert.equal(task.dispatch?.status, 'acknowledged')
})

test('projects every unseen lifecycle line appended between polls', async () => {
  const { home, statusPath } = taskHome()
  appendFileSync(statusPath, [
    'needs-decision: [key=review] choose behavior',
    'resolved: [key=review] keep behavior',
    'working: validation checks running'
  ].join('\n') + '\n')
  const harness = journalRuntime(home)
  await coordinatorFor(harness.runtime).poll()
  const history = (await onlyTask(home)).history ?? []
  assert.deepEqual(
    history.filter((event) => event.source === 'firstmate-status').map((event) => event.stage),
    ['implemented', 'decision', 'validating', 'validating']
  )
  assert.ok(history.every((event, index) => index === 0 || history[index - 1]!.occurredAt <= event.occurredAt))
})

test('persists lifecycle evidence appended after an earlier poll', async () => {
  const { home, statusPath } = taskHome()
  const harness = journalRuntime(home)
  const coordinator = coordinatorFor(harness.runtime)
  await coordinator.poll()
  appendFileSync(statusPath, 'needs-decision: [key=review] choose behavior\n')
  await coordinator.poll()
  const history = (await onlyTask(home)).history ?? []
  assert.ok(history.some((event) => event.stage === 'decision' && event.detail.includes('choose behavior')))
})

test('records actionable FirstMate implementation evidence before ADE reconciliation', async () => {
  const { home } = taskHome()
  const harness = journalRuntime(home)
  await coordinatorFor(harness.runtime).poll()
  const task = await onlyTask(home)
  assert.ok(task.history?.some((event) => (
    event.stage === 'implemented' && event.source === 'firstmate-status'
  )))
  assert.ok(task.history?.some((event) => event.dispatch?.status === 'claimed'))
})

test('folds every keyed FirstMate decision and its resolution durably', async () => {
  const lifecycle = firstMateLifecycleFromFiles({
    tasks: [{
      id: 'resize',
      meta: [
        'kind=ship', 'mode=no-mistakes', 'project=/mnt/d/Development/alpha/api',
        'worktree=/tmp/resize', 'harness=codex', firstMateTaskContextMetadata(alphaCodexContext)
      ].join('\n'),
      status: [
        'needs-decision: [key=api] choose API shape',
        'needs-decision: [key=copy] choose button copy',
        'resolved: [key=api] use stable API',
        'needs-decision: [key=theme] choose theme'
      ].join('\n')
    }]
  })
  assert.deepEqual(lifecycle.tasks[0]?.pendingDecisions, [
    { key: 'copy', detail: 'choose button copy' },
    { key: 'theme', detail: 'choose theme' }
  ])
})

test('replayed decision evidence cannot reopen a resolved decision', () => {
  const lifecycle = firstMateLifecycleFromFiles({
    tasks: [{
      id: 'resize',
      meta: [
        'kind=ship', 'mode=no-mistakes', 'project=/mnt/d/Development/alpha/api',
        'worktree=/tmp/resize', 'harness=codex', firstMateTaskContextMetadata(alphaCodexContext)
      ].join('\n'),
      status: [
        'needs-decision: [key=review] choose behavior',
        'resolved: [key=review] keep behavior',
        'needs-decision:   [key=review]   choose behavior'
      ].join('\n')
    }]
  })
  assert.deepEqual(lifecycle.tasks[0]?.pendingDecisions, [])
})

test('delayed decision evidence cannot regress a completed task', () => {
  const lifecycle = firstMateLifecycleFromFiles({
    tasks: [{
      id: 'resize',
      meta: [
        'kind=ship', 'mode=no-mistakes', 'project=/mnt/d/Development/alpha/api',
        'worktree=/tmp/resize', 'harness=codex', firstMateTaskContextMetadata(alphaCodexContext)
      ].join('\n'),
      status: [
        'completed: shipped',
        'needs-decision: [key=review] delayed older question'
      ].join('\n')
    }]
  })
  assert.equal(lifecycle.tasks[0]?.terminalOutcome, 'completed')
  assert.equal(lifecycle.tasks[0]?.stage, 'implemented')
})

test('delayed decision evidence cannot reopen a resolved key', () => {
  const lifecycle = firstMateLifecycleFromFiles({
    tasks: [{
      id: 'resize',
      meta: [
        'kind=ship', 'mode=no-mistakes', 'project=/mnt/d/Development/alpha/api',
        'worktree=/tmp/resize', 'harness=codex', firstMateTaskContextMetadata(alphaCodexContext)
      ].join('\n'),
      status: [
        'resolved: [key=review] keep behavior',
        'needs-decision: [key=review] delayed different wording'
      ].join('\n')
    }]
  })
  assert.equal(lifecycle.tasks[0]?.stage, 'validating')
  assert.deepEqual(lifecycle.tasks[0]?.pendingDecisions, [])
})

test('ambiguous nonterminal evidence permutations converge as indeterminate', () => {
  const statuses = [
    ['done: committed implementation', 'working: coding'],
    ['working: coding', 'done: committed implementation']
  ]
  const projections = statuses.map((status) => firstMateLifecycleFromFiles({
    tasks: [{
      id: 'resize',
      meta: [
        'kind=ship', 'mode=no-mistakes', 'project=/mnt/d/Development/alpha/api',
        'worktree=/tmp/resize', 'harness=codex', firstMateTaskContextMetadata(alphaCodexContext)
      ].join('\n'),
      status: status.join('\n')
    }]
  }).tasks[0])
  assert.deepEqual(projections.map((task) => [task?.stage, task?.nextAction]), [
    ['blocked', 'await-help'],
    ['blocked', 'await-help']
  ])
  assert.deepEqual(projections.map((task) => task?.terminalOutcome), ['indeterminate', 'indeterminate'])
})

test('conflicting terminal evidence permutations converge as indeterminate', () => {
  const statuses = [
    ['completed: shipped', 'failed: validation failed'],
    ['failed: validation failed', 'completed: shipped']
  ]
  const projections = statuses.map((status) => firstMateLifecycleFromFiles({
    tasks: [{
      id: 'resize',
      meta: [
        'kind=ship', 'mode=no-mistakes', 'project=/mnt/d/Development/alpha/api',
        'worktree=/tmp/resize', 'harness=codex', firstMateTaskContextMetadata(alphaCodexContext)
      ].join('\n'),
      status: status.join('\n')
    }]
  }).tasks[0])
  assert.deepEqual(projections.map((task) => [task?.stage, task?.terminalOutcome, task?.detail]), [
    ['blocked', 'indeterminate', 'conflicting terminal lifecycle evidence'],
    ['blocked', 'indeterminate', 'conflicting terminal lifecycle evidence']
  ])
})

test('projects and persists ordinary working evidence without scheduling actions', async () => {
  const { home, statusPath } = taskHome()
  writeFileSync(statusPath, 'working: coding implementation\n')
  const harness = journalRuntime(home)
  const coordinator = coordinatorFor(harness.runtime)
  await coordinator.poll()
  const task = await onlyTask(home)
  assert.equal(task.stage, 'working')
  assert.equal(task.nextAction, undefined)
  assert.equal(harness.continuations.length, 0)
  assert.ok(task.history?.some((event) => (
    event.stage === 'working' && event.detail === 'coding implementation'
  )))
})

test('projects ordinary resolved evidence outside no-mistakes as non-actionable', () => {
  const lifecycle = firstMateLifecycleFromFiles({
    tasks: [{
      id: 'resize',
      meta: [
        'kind=scout', 'project=/mnt/d/Development/alpha/api', 'worktree=/tmp/resize',
        'harness=codex', firstMateTaskContextMetadata(alphaCodexContext)
      ].join('\n'),
      status: 'resolved: [key=review] question settled'
    }]
  })
  assert.equal(lifecycle.tasks[0]?.stage, 'working')
  assert.equal(lifecycle.tasks[0]?.nextAction, undefined)
  assert.deepEqual(lifecycle.tasks[0]?.pendingDecisions, [])
})

test('implementation evidence outranks resolved state in every arrival order', () => {
  const statuses = [
    ['resolved: [key=review] question settled', 'done: committed follow-up fix'],
    ['done: committed follow-up fix', 'resolved: [key=review] question settled']
  ]
  const projections = statuses.map((status) => firstMateLifecycleFromFiles({
    tasks: [{
      id: 'resize',
      meta: [
        'kind=ship', 'mode=no-mistakes', 'project=/mnt/d/Development/alpha/api',
        'worktree=/tmp/resize', 'harness=codex', firstMateTaskContextMetadata(alphaCodexContext)
      ].join('\n'),
      status: status.join('\n')
    }]
  }).tasks[0])
  assert.deepEqual(projections.map((task) => [task?.stage, task?.nextAction]), [
    ['implemented', 'start-validation'],
    ['implemented', 'start-validation']
  ])
  assert.deepEqual(projections.map((task) => task?.pendingDecisions), [[], []])
})

test('projects unsupported and empty statuses as durable indeterminate evidence', async () => {
  for (const status of ['paused: awaiting operator', '']) {
    const { home, statusPath } = taskHome()
    writeFileSync(statusPath, status)
    const harness = journalRuntime(home)
    await coordinatorFor(harness.runtime).poll()
    const task = await onlyTask(home)
    assert.equal(task.stage, 'blocked')
    assert.equal(task.terminalOutcome, 'indeterminate')
    assert.equal(task.nextAction, 'await-help')
    assert.equal(harness.continuations.length, 0)
    assert.ok(task.history?.some((event) => event.outcome === 'indeterminate'))
  }
})

test('terminal outcomes tombstone every pending decision', () => {
  const lifecycle = firstMateLifecycleFromFiles({
    tasks: [{
      id: 'resize',
      meta: [
        'kind=ship', 'mode=no-mistakes', 'project=/mnt/d/Development/alpha/api',
        'worktree=/tmp/resize', 'harness=codex', firstMateTaskContextMetadata(alphaCodexContext)
      ].join('\n'),
      status: ['completed: shipped', 'needs-decision: [key=review] delayed question'].join('\n')
    }]
  })
  assert.equal(lifecycle.tasks[0]?.terminalOutcome, 'completed')
  assert.deepEqual(lifecycle.tasks[0]?.pendingDecisions, [])

  const forge = firstMatePrResolvedRecord({
    id: 'resize', mode: 'no-mistakes', stage: 'pr-ready', detail: 'Ready', statusHash: 'pr',
    prUrl: 'https://github.com/Tucaen/ade/pull/99',
    pendingDecisions: [{ key: 'review', detail: 'choose reviewer' }]
  }, 'merged', new Date('2026-08-24T12:00:00.000Z'))
  assert.deepEqual(forge?.pendingDecisions, [])
})

test('projects terminal journal tasks after FirstMate removes their live carriers', () => {
  const task: FirstMateLifecycleTask = {
    id: 'resize', mode: 'no-mistakes', context: alphaCodexContext, worktree: '/tmp/resize',
    stage: 'pr-ready', detail: 'PR ready', statusHash: 'pr-evidence', prUrl: 'https://github.com/Tucaen/ade/pull/99'
  }
  const terminal = firstMatePrResolvedRecord(task, 'merged', new Date('2026-08-24T12:00:00.000Z'))!
  const lifecycle = firstMateLifecycleFromFiles({
    tasks: [],
    journal: JSON.stringify({ version: 1, tasks: { resize: terminal } })
  })
  assert.equal(lifecycle.tasks[0]?.id, 'resize')
  assert.equal(lifecycle.tasks[0]?.terminalOutcome, 'completed')
  assert.deepEqual(lifecycle.closedTaskIds, ['resize'])
})

test('retains completed and cancelled FirstMate carriers after live cleanup', async () => {
  for (const [verb, outcome] of [['completed', 'completed'], ['cancelled', 'cancelled']] as const) {
    const { home, statusPath } = taskHome()
    writeFileSync(statusPath, `${verb}: authoritative terminal outcome\n`)
    const harness = journalRuntime(home)
    await coordinatorFor(harness.runtime).poll()
    unlinkSync(join(home, 'state', 'resize.meta'))
    unlinkSync(statusPath)
    const restarted = await readFirstMateLifecycle(home)
    assert.equal(restarted.tasks[0]?.terminalOutcome, outcome)
    assert.equal(restarted.tasks[0]?.history?.at(-1)?.source, 'firstmate-status')
    assert.deepEqual(restarted.closedTaskIds, ['resize'])
  }
})

test('serializes concurrent journal updates without losing either task', async () => {
  const { home } = taskHome()
  const record = (detail: string): FirstMateLifecycleRecord => ({
    stage: 'implemented', detail, statusHash: detail, updatedAt: '2026-08-24T12:00:00.000Z'
  })
  await Promise.all([
    recordFirstMateLifecycle(home, 'alpha', record('alpha')),
    recordFirstMateLifecycle(home, 'beta', record('beta'))
  ])
  const files = await readFirstMateLifecycleFiles(home)
  const journal = JSON.parse(files.journal!) as { tasks: Record<string, unknown> }
  assert.deepEqual(Object.keys(journal.tasks).sort(), ['alpha', 'beta'])
})

test('indeterminate dispatch delivery is explicit in durable history', async () => {
  const { home } = taskHome()
  const runtime = journalRuntime(home, {
    continueValidation: () => ({ outcome: 'indeterminate', message: 'acknowledgement lost' })
  })
  await coordinatorFor(runtime.runtime).poll()
  const task = await onlyTask(home)
  assert.equal(task.dispatch?.status, 'unresolved')
  assert.match(task.detail, /cannot establish whether it reached FirstMate/)
  assert.ok(task.history?.some((event) => event.dispatch?.status === 'unresolved'))
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

test('blocks a ship with no durable ADE context instead of supervising it against mutable defaults', () => {
  const lifecycle = firstMateLifecycleFromFiles({
    tasks: [{
      id: 'legacy-ship',
      meta: [
        'kind=ship',
        'mode=no-mistakes',
        'project=/mnt/d/Development/alpha/api',
        'worktree=/home/tucaen/.treehouse/alpha/legacy-ship',
        'harness=codex',
        'model=gpt-5.6-sol'
      ].join('\n'),
      status: 'done: committed implementation\n'
    }]
  })

  assert.equal(lifecycle.tasks[0]?.stage, 'blocked')
  assert.match(lifecycle.tasks[0]?.detail ?? '', /no durable ADE task context/i)
})

/**
 * A done ship pinned to alpha's external checkout, carrying the given gathered provenance. The reported
 * worktree path stays a plausible WSL path so the pinned-context carrier round-trips; the provenance
 * object is the independent Git evidence the runtime gathers from FirstMate's own worktree.
 */
function shipTask(provenance: FirstMateWorktreeProvenance): FirstMateRawTask {
  return {
    id: 'resize',
    meta: [
      'kind=ship',
      'mode=no-mistakes',
      'yolo=off',
      `project=${alphaCodexContext.project.wslPath}`,
      'worktree=/home/tucaen/.treehouse/alpha/resize',
      'harness=codex',
      'model=gpt-5.6-sol',
      firstMateTaskContextMetadata(alphaCodexContext)
    ].join('\n'),
    status: 'done: committed implementation\n',
    provenance
  }
}

test('supervises a crew worktree that shares its pinned checkout Git common directory', () => {
  const { primary, worktree } = createGitCrew('shared')

  const lifecycle = firstMateLifecycleFromFiles({ tasks: [shipTask(gitProvenance(worktree, primary))] })

  assert.equal(lifecycle.tasks[0]?.stage, 'implemented')
  assert.equal(lifecycle.tasks[0]?.nextAction, 'start-validation')
  assert.deepEqual(lifecycle.tasks[0]?.context, alphaCodexContext)
})

test('refuses a crew worktree cut from a foreign repository as a distinct integration failure', () => {
  const pinned = createGitCrew('pinned')
  const foreign = createGitCrew('foreign')

  const lifecycle = firstMateLifecycleFromFiles({
    tasks: [shipTask(gitProvenance(foreign.worktree, pinned.primary))]
  })

  assert.equal(lifecycle.tasks[0]?.stage, 'blocked')
  assert.equal(lifecycle.tasks[0]?.nextAction, 'await-help')
  assert.match(lifecycle.tasks[0]?.detail ?? '', /foreign repository/i)
  assert.match(lifecycle.tasks[0]?.detail ?? '', /not supervised, validated, or counted as progress/i)
})

test('refuses the user primary checkout reported as a crew worktree', () => {
  const { primary } = createGitCrew('primary')

  // Probing the primary working tree itself: its git-dir equals its git-common-dir, which the earlier
  // path-inequality check can never catch but the provenance proof does.
  const lifecycle = firstMateLifecycleFromFiles({ tasks: [shipTask(gitProvenance(primary, primary))] })

  assert.equal(lifecycle.tasks[0]?.stage, 'blocked')
  assert.equal(lifecycle.tasks[0]?.nextAction, 'await-help')
  assert.match(lifecycle.tasks[0]?.detail ?? '', /primary/i)
})

test('blocks a task whose crew worktree provenance cannot be read', () => {
  const lifecycle = firstMateLifecycleFromFiles({
    tasks: [shipTask({
      worktree: { error: 'fatal: not a git repository' },
      checkout: { commonDir: '/mnt/d/Development/alpha/api/.git' }
    })]
  })

  assert.equal(lifecycle.tasks[0]?.stage, 'blocked')
  assert.equal(lifecycle.tasks[0]?.nextAction, 'await-help')
  assert.match(lifecycle.tasks[0]?.detail ?? '', /provenance ADE could not read/i)
})

test('surfaces the recorded live worker tmux window binding for a task', () => {
  const { primary, worktree } = createGitCrew('windowed')
  const task: FirstMateRawTask = {
    id: 'resize',
    meta: [
      'kind=ship',
      'mode=no-mistakes',
      'yolo=off',
      `project=${alphaCodexContext.project.wslPath}`,
      'worktree=/home/tucaen/.treehouse/alpha/resize',
      'window=firstmate:fm-resize',
      'harness=codex',
      'model=gpt-5.6-sol',
      firstMateTaskContextMetadata(alphaCodexContext)
    ].join('\n'),
    status: 'done: committed implementation\n',
    provenance: gitProvenance(worktree, primary)
  }

  const lifecycle = firstMateLifecycleFromFiles({ tasks: [task] })

  assert.equal(lifecycle.tasks[0]?.window, 'firstmate:fm-resize')
})

test('leaves the window binding absent for a task that never recorded a live worker window', () => {
  const { primary, worktree } = createGitCrew('windowless')

  const lifecycle = firstMateLifecycleFromFiles({ tasks: [shipTask(gitProvenance(worktree, primary))] })

  assert.equal(lifecycle.tasks[0]?.window, undefined)
})

test('supervises a scout with its pinned report-only contract without inventing ship flags', () => {
  const lifecycle = firstMateLifecycleFromFiles({
    tasks: [{
      id: 'alpha-scout',
      meta: [
        'kind=scout',
        `project=${alphaCodexContext.project.wslPath}`,
        'worktree=/home/tucaen/.treehouse/alpha/alpha-scout',
        'harness=codex',
        'model=gpt-5.6-sol',
        firstMateTaskContextMetadata(alphaCodexContext)
      ].join('\n'),
      status: 'done: report data/alpha-scout/report.md\n'
    }]
  })

  assert.equal(lifecycle.tasks[0]?.mode, 'scout')
  assert.equal(lifecycle.tasks[0]?.stage, 'implemented')
  assert.equal(lifecycle.tasks[0]?.nextAction, undefined)
  assert.deepEqual(lifecycle.tasks[0]?.context, alphaCodexContext)
})

test('dispatches a second task while another awaits a decision under its own validation scope', async () => {
  const continuations: string[] = []
  const coordinator = createFirstMateLifecycleCoordinator({
    runtime: {
      async lifecycle() {
        return {
          supervision: 'app-native' as const,
          tasks: [{
            id: 'alpha', mode: 'no-mistakes', stage: 'decision' as const,
            detail: 'approval required', statusHash: 'alpha-hash', nextAction: 'await-decision' as const,
            dispatch: { id: 'alpha.dispatch.1', status: 'acknowledged' as const, attempt: 1 }
          }, {
            id: 'beta', mode: 'no-mistakes', stage: 'implemented' as const,
            detail: 'committed', statusHash: 'beta-hash', nextAction: 'start-validation' as const
          }]
        }
      },
      async continueValidation(taskId: string): Promise<FirstMateValidationDelivery> {
        continuations.push(taskId)
        return { outcome: 'acknowledged' }
      },
      async recordLifecycle() {}
    },
    wakeCaptain: async () => ({ ok: true })
  })

  await coordinator.poll()

  assert.deepEqual(continuations, ['beta'], 'each task validates under its own scope, so another task does not block it')
})

test('derives a stable dispatch identity for one continuation, independent of the delivery attempt', () => {
  const identity = firstMateValidationDispatchId('resize', 'a1b2c3')

  assert.equal(
    identity,
    firstMateValidationDispatchId('resize', 'a1b2c3'),
    'the same logical continuation always names one identity, so every attempt reuses it'
  )
  assert.notEqual(
    identity,
    firstMateValidationDispatchId('resize', 'd4e5f6'),
    'a new implementation line is a new operation with its own identity'
  )
  assert.notEqual(identity, firstMateValidationDispatchId('panel', 'a1b2c3'))
  assert.match(identity, /^[a-zA-Z0-9._-]+$/, 'the identity travels as a command argument')
})

test('carries the dispatch identity and its durable ledger into the continuation so FirstMate can deduplicate it', () => {
  const continuation = noMistakesContinuation(
    'codex',
    '/home/config/ade-runtime.json',
    'resize.a1b2c3',
    '/home/state/.ade-validation-dispatches.json'
  )

  assert.match(continuation, /^\$no-mistakes/)
  assert.match(continuation, /resize\.a1b2c3/)
  assert.match(continuation, /idempotenc/i)
  assert.match(continuation, /do not begin a second/i)
  assert.match(
    continuation,
    /\.ade-validation-dispatches\.json/,
    'the receiver must be pointed at durable evidence, not asked to trust the prompt alone'
  )
})

test('fails validation closed until the captain uses the pinned task cache and worktree-local gate remote', () => {
  const continuation = noMistakesContinuation(
    'codex',
    '/home/state/task.ade-runtime.json',
    'task.dispatch',
    '/home/state/.ade-validation-dispatches.json'
  )

  assert.match(continuation, /set NM_HOME to validator\.nmHome/)
  assert.match(continuation, /exact task-scoped data directory/)
  assert.match(continuation, /worktree's no-mistakes remote/)
  assert.match(continuation, /inherited NM_HOME or stale worktree-local remote must never start validation/)
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

test('continues a committed worker directly into validation exactly once without waking the captain', async () => {
  let task = implementedTask()
  const records: FirstMateLifecycleRecord[] = []
  const continuations: string[] = []
  const wakes: string[] = []
  const runtime = {
    async lifecycle(): Promise<FirstMateLifecycleStatus> {
      return { supervision: 'app-native', tasks: [task] }
    },
    async continueValidation(taskId: string, dispatchId: string): Promise<FirstMateValidationDelivery> {
      continuations.push(`${taskId}@${dispatchId}`)
      return { outcome: 'acknowledged' }
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

  const dispatchId = firstMateValidationDispatchId('resize', 'implementation-1')
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
  assert.equal(
    wakes.length,
    0,
    'dispatching/validating is a transient step this same reconcile pass already resolved, and ' +
      "FirstMate's own watcher already wakes live on the crew's status line - a duplicate chat push here " +
      'would only interrupt the conversation a second time for the same event'
  )
})

test('wakes the captain once a task settles into a terminal stage, and again if it later re-blocks', async () => {
  let task = implementedTask()
  const wakes: string[] = []
  let deliveryOutcome: FirstMateValidationDelivery = { outcome: 'indeterminate', message: 'wsl.exe timed out' }
  const runtime = {
    async lifecycle(): Promise<FirstMateLifecycleStatus> {
      return { supervision: 'app-native', tasks: [task] }
    },
    async continueValidation(): Promise<FirstMateValidationDelivery> {
      return deliveryOutcome
    },
    async recordLifecycle(_taskId: string, record: FirstMateLifecycleRecord): Promise<void> {
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

  // An indeterminate delivery blocks the task on ADE's own dispatch bookkeeping alone - there is no
  // crew status line behind it, so FirstMate has no other way to learn about it.
  await coordinator.poll()
  assert.equal(task.stage, 'blocked')
  assert.equal(wakes.length, 1, 'a fresh terminal reach must still wake the captain')
  assert.match(wakes[0]!, /resize=blocked/)

  // Re-polling an unchanged blocked task must not nag again.
  await coordinator.poll()
  assert.equal(wakes.length, 1, 'an unchanged terminal state must not re-wake on every poll')

  // An operator releases the dispatch, the resend succeeds, and the task leaves the terminal stage.
  assert.deepEqual(await coordinator.releaseDispatch('resize'), { ok: true })
  deliveryOutcome = { outcome: 'acknowledged' }
  await coordinator.poll()
  assert.equal(task.stage, 'validating')
  assert.equal(wakes.length, 1, 'leaving the terminal stage for a transient one must not itself wake')

  // A later, unrelated failure blocks the task again from a fresh cause. Even though the delivered
  // fingerprint had been reset in between, this is a genuinely new terminal reach and must wake again.
  deliveryOutcome = { outcome: 'indeterminate', message: 'wsl.exe timed out' }
  task = { ...task, stage: 'implemented', nextAction: 'start-validation', dispatch: undefined, statusHash: 'implementation-2' }
  await coordinator.poll()
  assert.equal(task.stage, 'blocked')
  assert.equal(wakes.length, 2, 'a new terminal reach after leaving the terminal stage must wake again')
})

test('wakes again for a terminal reach that looks identical to one delivered before an intervening non-terminal stage', async () => {
  const blockedShape: FirstMateLifecycleTask = {
    id: 'resize',
    mode: 'no-mistakes',
    stage: 'blocked',
    detail: 'credentials are required',
    statusHash: 'implementation-1',
    nextAction: 'await-help'
  }
  let task: FirstMateLifecycleTask = blockedShape
  const wakes: string[] = []
  const coordinator = createFirstMateLifecycleCoordinator({
    runtime: {
      async lifecycle(): Promise<FirstMateLifecycleStatus> {
        return { supervision: 'app-native', tasks: [task] }
      },
      async continueValidation(): Promise<FirstMateValidationDelivery> {
        return { outcome: 'acknowledged' }
      },
      async recordLifecycle(): Promise<void> {}
    },
    now: () => new Date('2026-08-14T18:00:00.000Z'),
    wakeCaptain: async (message) => {
      wakes.push(message)
      return { ok: true }
    }
  })

  await coordinator.poll()
  assert.equal(wakes.length, 1, 'the first sighting of this blocked task must wake the captain')

  // The crew resolves it and moves on to a transient stage - not a stage this coordinator wakes on.
  task = { ...blockedShape, stage: 'validating', nextAction: 'await-validation' }
  await coordinator.poll()
  assert.equal(wakes.length, 1, 'moving to a non-terminal stage must not itself wake')

  // The exact same blocked detail and status hash reappear. Comparing only against the last
  // delivered fingerprint would wrongly treat this as already-announced; it must wake again.
  task = blockedShape
  await coordinator.poll()
  assert.equal(
    wakes.length,
    2,
    'a terminal state that recurs after being cleared is a new episode, not a repeat of the old one'
  )
})

test('makes a failed validation continuation durable and visible instead of claiming progress', async () => {
  let task = implementedTask()
  const coordinator = createFirstMateLifecycleCoordinator({
    runtime: {
      async lifecycle(): Promise<FirstMateLifecycleStatus> {
        return { supervision: 'app-native', tasks: [task] }
      },
      async continueValidation(): Promise<FirstMateValidationDelivery> {
        return { outcome: 'rejected-before-send', message: 'task endpoint is unavailable' }
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
      async continueValidation(): Promise<FirstMateValidationDelivery> {
        continuations += 1
        return { outcome: 'acknowledged' }
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
    continueValidation: () => ({ outcome: 'rejected-before-send', message: 'task endpoint is unavailable' })
  })
  const coordinator = coordinatorFor(harness.runtime, 2)

  await coordinator.poll()

  const retryable = await onlyTask(home)
  assert.equal(retryable.stage, 'implemented', 'a rejected dispatch stays actionable')
  assert.equal(retryable.nextAction, 'start-validation')
  assert.equal(retryable.dispatch?.status, 'retryable')
  assert.equal(retryable.dispatch?.attempt, 1)

  await coordinator.poll()

  const stableId = firstMateValidationDispatchId('resize', retryable.statusHash)
  assert.deepEqual(
    harness.continuations.map((call) => call.dispatchId),
    [stableId, stableId],
    'every attempt of the same continuation reuses one stable identity, so a resend is deduplicable'
  )
  assert.equal(harness.continuations[1]?.dispatchId, harness.continuations[0]?.dispatchId)

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

test('starts validation exactly once when an acknowledgement is lost and recovery resends the identity', async () => {
  const { home } = taskHome()
  // Durable evidence the receiving FirstMate boundary keeps, keyed by the stable dispatch identity.
  const started = new Set<string>()
  let validationStarts = 0
  const harness = journalRuntime(home, {
    continueValidation: (_taskId, dispatchId): FirstMateValidationDelivery => {
      if (started.has(dispatchId)) {
        // A repeated identity is recognised: the boundary does not start a second validation run.
        return { outcome: 'acknowledged' }
      }
      started.add(dispatchId)
      validationStarts += 1
      // Validation did start, but ADE never learns it: the acknowledgement is lost in transit.
      return { outcome: 'indeterminate', message: 'wsl.exe timed out before the send acknowledged' }
    }
  })
  const coordinator = coordinatorFor(harness.runtime)

  await coordinator.poll()

  const unresolved = await onlyTask(home)
  assert.equal(unresolved.stage, 'blocked')
  assert.equal(unresolved.dispatch?.status, 'unresolved', 'a lost acknowledgement is never auto-resent')
  assert.equal(validationStarts, 1)

  // Explicit recovery: releasing the dispatch resends the SAME identity the receiver already saw.
  assert.deepEqual(await coordinator.releaseDispatch('resize'), { ok: true })
  await coordinator.poll()

  const identity = harness.continuations[0]!.dispatchId
  assert.deepEqual(
    harness.continuations.map((call) => call.dispatchId),
    [identity, identity],
    'the resend reuses the identity rather than minting a fresh one'
  )
  assert.equal(
    validationStarts,
    1,
    'the receiving boundary deduplicated the resend, so validation started exactly once'
  )
  const recovered = await onlyTask(home)
  assert.equal(recovered.stage, 'validating')
  assert.equal(recovered.dispatch?.status, 'acknowledged')
})

test('keeps a pre-send rejection retryable and never starts validation', async () => {
  const { home } = taskHome()
  let validationStarts = 0
  let rejectNext = true
  const harness = journalRuntime(home, {
    continueValidation: (): FirstMateValidationDelivery => {
      if (rejectNext) {
        rejectNext = false
        // Proven to have failed before the external send: nothing reached FirstMate.
        return { outcome: 'rejected-before-send', message: 'the pinned task endpoint metadata is unavailable' }
      }
      validationStarts += 1
      return { outcome: 'acknowledged' }
    }
  })
  const coordinator = coordinatorFor(harness.runtime)

  await coordinator.poll()

  const retryable = await onlyTask(home)
  assert.equal(retryable.stage, 'implemented', 'a pre-send rejection stays actionable')
  assert.equal(retryable.nextAction, 'start-validation')
  assert.equal(retryable.dispatch?.status, 'retryable')
  assert.equal(validationStarts, 0, 'a pre-send rejection never started validation')

  // The same stable identity retries automatically, within budget, without operator help.
  await coordinator.poll()

  assert.equal(validationStarts, 1)
  assert.equal(
    harness.continuations[1]!.dispatchId,
    harness.continuations[0]!.dispatchId,
    'the automatic retry reuses the stable identity'
  )
  const validating = await onlyTask(home)
  assert.equal(validating.stage, 'validating')
  assert.equal(validating.dispatch?.status, 'acknowledged')
})

test('recovers an attempts-exhausted dispatch on request without hand-editing files', async () => {
  const { home } = taskHome()
  let sendable = false
  const harness = journalRuntime(home, {
    continueValidation: (): FirstMateValidationDelivery => (
      sendable
        ? { outcome: 'acknowledged' }
        : { outcome: 'rejected-before-send', message: 'task endpoint is unavailable' }
    )
  })
  const coordinator = coordinatorFor(harness.runtime, 1)

  await coordinator.poll()
  await coordinator.poll()

  const blocked = await onlyTask(home)
  assert.equal(blocked.stage, 'blocked')
  assert.equal(blocked.dispatch?.status, 'retryable', 'an exhausted pre-send budget stays proven-undelivered')

  // Release is the wrong tool here: nothing was ever sent, so there is no identity to resend.
  const wrongTool = await coordinator.retryDispatch('absent')
  assert.equal(wrongTool.ok, false)
  assert.match(wrongTool.message ?? '', /no durable state/i)
  const notReleasable = await coordinator.releaseDispatch('resize')
  assert.equal(notReleasable.ok, false)

  sendable = true
  assert.deepEqual(await coordinator.retryDispatch('resize'), { ok: true })
  await coordinator.poll()

  const validating = await onlyTask(home)
  assert.equal(validating.stage, 'validating')
  assert.equal(validating.dispatch?.status, 'acknowledged')
  assert.equal(validating.dispatch?.attempt, 1, 'the recovery starts a fresh attempt budget')
  assert.equal(
    harness.continuations.at(-1)!.dispatchId,
    firstMateValidationDispatchId('resize', validating.statusHash),
    'the fresh attempt reuses the stable identity'
  )
})

function prReadyTaskHome(prUrl: string): { home: string; statusPath: string } {
  const { home, statusPath } = taskHome()
  appendFileSync(statusPath, `done: PR ${prUrl}\n`)
  return { home, statusPath }
}

function journalRuntimeWithPrCheck(
  home: string,
  checkPullRequestStatus: (url: string) => Promise<FirstMatePullRequestCheck>
): {
  runtime: JournalRuntime['runtime'] & {
    checkPullRequestStatus(url: string): Promise<FirstMatePullRequestCheck>
  }
  checks: string[]
} {
  const { runtime } = journalRuntime(home)
  const checks: string[] = []
  return {
    checks,
    runtime: {
      ...runtime,
      async checkPullRequestStatus(url: string): Promise<FirstMatePullRequestCheck> {
        checks.push(url)
        return checkPullRequestStatus(url)
      }
    }
  }
}

test('drops a pr-ready task off the active list once its GitHub PR is confirmed merged', async () => {
  const prUrl = 'https://github.com/Tucaen/ade/pull/101'
  const { home } = prReadyTaskHome(prUrl)
  const { runtime, checks } = journalRuntimeWithPrCheck(home, async () => ({ ok: true, state: 'merged' }))
  const coordinator = createFirstMateLifecycleCoordinator({
    runtime,
    now: () => new Date('2026-08-14T18:00:00.000Z'),
    wakeCaptain: async () => ({ ok: true })
  })

  let lifecycle = await readFirstMateLifecycle(home)
  assert.equal(lifecycle.tasks[0]?.stage, 'pr-ready')
  const taskId = lifecycle.tasks[0]!.id

  await coordinator.poll()

  assert.deepEqual(checks, [prUrl])
  lifecycle = await readFirstMateLifecycle(home)
  assert.equal(lifecycle.tasks.length, 0, 'a confirmed merge must stop presenting the task as awaiting review')
  assert.deepEqual(lifecycle.closedTaskIds, [taskId])
})

test('leaves a pr-ready task alone while its GitHub PR is still open', async () => {
  const prUrl = 'https://github.com/Tucaen/ade/pull/102'
  const { home } = prReadyTaskHome(prUrl)
  const { runtime, checks } = journalRuntimeWithPrCheck(home, async () => ({ ok: true, state: 'open' }))
  const coordinator = createFirstMateLifecycleCoordinator({
    runtime,
    now: () => new Date('2026-08-14T18:00:00.000Z'),
    wakeCaptain: async () => ({ ok: true })
  })

  await coordinator.poll()

  assert.deepEqual(checks, [prUrl])
  const lifecycle = await readFirstMateLifecycle(home)
  assert.equal(lifecycle.tasks[0]?.stage, 'pr-ready')
  assert.equal(lifecycle.tasks[0]?.prUrl, prUrl)
})

test('never asks about a PR whose forge ADE has no live check for', async () => {
  const prUrl = 'https://gitlab.com/Tucaen/ade/-/merge_requests/5'
  const { home } = prReadyTaskHome(prUrl)
  const { runtime, checks } = journalRuntimeWithPrCheck(home, async () => ({ ok: true, state: 'merged' }))
  const coordinator = createFirstMateLifecycleCoordinator({
    runtime,
    now: () => new Date('2026-08-14T18:00:00.000Z'),
    wakeCaptain: async () => ({ ok: true })
  })

  await coordinator.poll()

  assert.deepEqual(checks, [], 'an unrecognised forge must never be guessed at')
  const lifecycle = await readFirstMateLifecycle(home)
  assert.equal(lifecycle.tasks[0]?.stage, 'pr-ready')
  assert.equal(lifecycle.tasks[0]?.prUrl, prUrl)
})

test('leaves a pr-ready task exactly as it is when the live merge check fails', async () => {
  const prUrl = 'https://github.com/Tucaen/ade/pull/103'
  const { home } = prReadyTaskHome(prUrl)
  const { runtime, checks } = journalRuntimeWithPrCheck(home, async () => {
    throw new Error('gh: not authenticated')
  })
  const coordinator = createFirstMateLifecycleCoordinator({
    runtime,
    now: () => new Date('2026-08-14T18:00:00.000Z'),
    wakeCaptain: async () => ({ ok: true })
  })

  await coordinator.poll()

  assert.deepEqual(checks, [prUrl])
  const lifecycle = await readFirstMateLifecycle(home)
  assert.equal(lifecycle.tasks[0]?.stage, 'pr-ready', 'a failed check must fail open, never block or error the UI')
  assert.equal(lifecycle.tasks[0]?.prUrl, prUrl)
})

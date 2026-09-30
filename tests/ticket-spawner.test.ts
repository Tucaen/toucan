import { strict as assert } from 'node:assert'
import { test } from 'vitest'
import type { GitResult } from '../src/main/git-worktree'
import { createTicketSpawner, type TicketSpawnerOptions } from '../src/main/ticket-spawner'
import type { OrchestrationTicket } from '../src/shared/orchestration'
import type { TicketSessionCanvasRequest } from '../src/shared/ticket-session-spawn'
import type { WorktreeCreateRequest } from '../src/shared/worktree'

// The ticket spawner (#34): worktree through the worktree manager, push guard, the project's setup
// command, then the canvas - and the model and effort read back from the session that came up.

const ticket: OrchestrationTicket = {
  id: '34',
  title: 'Spawn',
  body: 'Start one ticket session.',
  blockedBy: [],
  attempts: 0,
  mergeStatus: 'pending'
}

const request = {
  orchestrator: { nodeId: 'orchestrator-1', conversationId: 'conversation-1' },
  projectPath: 'D:\\project',
  targetBranch: 'main',
  ticket,
  model: 'claude-opus-5-5',
  effort: 'high'
}

const ok = (stdout = ''): GitResult => ({ code: 0, stdout, stderr: '' })

function harness(overrides: Partial<TicketSpawnerOptions> = {}) {
  const log: string[] = []
  const created: WorktreeCreateRequest[] = []
  const canvas: TicketSessionCanvasRequest[] = []
  const git: string[][] = []
  const options: TicketSpawnerOptions = {
    worktrees: {
      async create(worktree) {
        created.push(worktree)
        log.push(`create ${worktree.branch}`)
        return {
          ok: true,
          worktree: { path: `D:\\project-${worktree.branch}`, branch: worktree.branch, baseRef: 'main' }
        }
      }
    },
    runGit: async (args) => {
      git.push(args)
      return ok()
    },
    installGuard: async (path) => {
      log.push(`guard ${path}`)
      return { ok: true }
    },
    project: async (path) => (path === 'D:\\project' ? { id: 'project-1', setupCommand: 'npm ci' } : undefined),
    runSetup: async (command, cwd) => {
      log.push(`setup ${command} in ${cwd}`)
      return { ok: true }
    },
    canvas: {
      async startTicketSession(canvasRequest) {
        canvas.push(canvasRequest)
        log.push('canvas')
        return { ok: true, nodeId: 'ticket-node-1', conversationId: 'ticket-conversation-1' }
      }
    },
    session: (nodeId) =>
      nodeId === 'orchestrator-1'
        ? { permissionMode: 'acceptEdits' }
        : nodeId === 'ticket-node-1'
          ? { model: 'claude-opus-5-5', effort: 'high' }
          : undefined,
    offeredModels: () => ['claude-opus-5-5', 'claude-sonnet-5-5'],
    onWorktreeCreated: (path) => log.push(`registered ${path}`),
    ...overrides
  }
  return { spawner: createTicketSpawner(options), log, created, canvas, git }
}

test('a spawn creates the worktree, guards it, runs setup and then starts the chat on the canvas', async () => {
  const { spawner, log, created, canvas } = harness()
  const result = await spawner.spawn(request)
  assert.deepEqual(result, {
    ok: true,
    session: {
      nodeId: 'ticket-node-1',
      conversationId: 'ticket-conversation-1',
      worktreePath: 'D:\\project-ticket/34',
      branch: 'ticket/34'
    },
    model: 'claude-opus-5-5',
    effort: 'high',
    warnings: []
  })
  // A fresh local branch from the target branch, through the worktree manager.
  assert.deepEqual(created, [{ projectPath: 'D:\\project', branch: 'ticket/34', baseRef: 'main' }])
  // The chat starts only once the worktree is guarded and set up.
  assert.deepEqual(log, [
    'create ticket/34',
    'registered D:\\project-ticket/34',
    'guard D:\\project-ticket/34',
    'setup npm ci in D:\\project-ticket/34',
    'canvas'
  ])
  const [started] = canvas
  assert.equal(started.projectId, 'project-1')
  assert.deepEqual(started.worktree, { path: 'D:\\project-ticket/34', branch: 'ticket/34', baseRef: 'main' })
  assert.equal(started.label, '#34 Spawn')
  assert.equal(started.modelId, 'claude-opus-5-5')
  assert.equal(started.effortId, 'high')
  // Ticket sessions inherit the orchestrator's permission mode.
  assert.equal(started.permissionMode, 'acceptEdits')
  assert.deepEqual(started.orchestratedBy, { nodeId: 'orchestrator-1', conversationId: 'conversation-1' })
  assert.ok(started.prompt.startsWith('/implement #34 Spawn\n\nStart one ticket session.'))
  assert.ok(started.prompt.includes('D:\\project-ticket/34'))
})

test('a retry gets the next free branch name', async () => {
  const { spawner, created } = harness({
    worktrees: {
      async create(worktree) {
        created.push(worktree)
        if (worktree.branch === 'ticket/34') return { ok: false, conflict: true, message: 'Branch exists' }
        return { ok: true, worktree: { path: 'D:\\project-2', branch: worktree.branch, baseRef: 'main' } }
      }
    }
  })
  const result = await spawner.spawn(request)
  assert.equal(result.ok && result.session.branch, 'ticket/34-2')
  assert.deepEqual(
    created.map((entry) => entry.branch),
    ['ticket/34', 'ticket/34-2']
  )
})

test('a worktree git refuses for another reason fails the spawn without trying other names', async () => {
  const { spawner, created, canvas } = harness({
    worktrees: {
      async create(worktree) {
        created.push(worktree)
        return { ok: false, message: 'fatal: invalid reference: main' }
      }
    }
  })
  const result = await spawner.spawn(request)
  assert.equal(result.ok, false)
  assert.match(!result.ok ? result.error : '', /invalid reference/)
  assert.equal(created.length, 1)
  assert.equal(canvas.length, 0)
})

test('a failing setup command or guard removes the fresh worktree and its branch', async () => {
  for (const failure of ['setup', 'guard'] as const) {
    const { spawner, canvas, git } = harness({
      ...(failure === 'setup'
        ? { runSetup: async () => ({ ok: false as const, error: 'npm ERR! missing script' }) }
        : { installGuard: async () => ({ ok: false as const, error: 'could not install the push guard' }) })
    })
    const result = await spawner.spawn(request)
    assert.equal(result.ok, false, failure)
    assert.match(!result.ok ? result.error : '', failure === 'setup' ? /npm ERR! missing script/ : /push guard/)
    assert.equal(canvas.length, 0, failure)
    assert.deepEqual(git, [
      ['worktree', 'remove', '--force', 'D:\\project-ticket/34'],
      ['branch', '-D', 'ticket/34']
    ])
  }
})

test('a project without a setup command starts the chat without running one', async () => {
  const { spawner, log } = harness({ project: async () => ({ id: 'project-1' }) })
  assert.equal((await spawner.spawn(request)).ok, true)
  assert.ok(!log.some((entry) => entry.startsWith('setup')))
})

test('a model the picker does not offer is refused before anything is created', async () => {
  const { spawner, created } = harness()
  const result = await spawner.spawn({ ...request, model: 'claude-imaginary' })
  assert.equal(result.ok, false)
  assert.match(!result.ok ? result.error : '', /claude-imaginary.*claude-opus-5-5/)
  assert.equal(created.length, 0)
  // An empty catalogue - no Claude session has run yet - cannot refuse anything.
  const unknown = harness({ offeredModels: () => [] })
  assert.equal((await unknown.spawner.spawn({ ...request, model: 'claude-imaginary' })).ok, true)
})

test('a project Toucan does not know is refused', async () => {
  const { spawner, created } = harness({ project: async () => undefined })
  const result = await spawner.spawn(request)
  assert.match(!result.ok ? result.error : '', /not open in Toucan/)
  assert.equal(created.length, 0)
})

test('a canvas that cannot start the chat fails the spawn but keeps the worktree it registered', async () => {
  const { spawner, git } = harness({
    canvas: { startTicketSession: async () => ({ ok: false, message: 'Toucan is not open on the desktop.' }) }
  })
  const result = await spawner.spawn(request)
  assert.match(!result.ok ? result.error : '', /not open on the desktop.*D:\\project-ticket\/34/s)
  assert.deepEqual(git, [])
})

test('a session that came up on another model or effort is reported, not hidden', async () => {
  const { spawner } = harness({
    session: (nodeId) =>
      nodeId === 'ticket-node-1' ? { model: 'claude-sonnet-5-5', effort: 'medium' } : { permissionMode: 'default' }
  })
  const result = await spawner.spawn(request)
  assert.ok(result.ok)
  assert.equal(result.model, 'claude-sonnet-5-5')
  assert.equal(result.effort, 'medium')
  assert.equal(result.warnings.length, 2)
  assert.match(result.warnings.join('\n'), /claude-sonnet-5-5/)
  assert.match(result.warnings.join('\n'), /medium/)
})

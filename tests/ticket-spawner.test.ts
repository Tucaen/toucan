import { strict as assert } from 'node:assert'
import { test } from 'vitest'
import type { GitResult } from '../src/main/git-worktree'
import {
  createTicketSpawner,
  type SessionSettings,
  type TicketSpawner,
  type TicketSpawnerOptions,
  type TicketSpawnRequest,
  type TicketSpawnSettlement
} from '../src/main/ticket-spawner'
import { orchestrationBranchScope, type OrchestrationTicket } from '../src/shared/orchestration'
import type { TicketSessionCanvasRequest, TicketSessionCanvasResult } from '../src/shared/ticket-session-spawn'
import type { WorktreeCreateRequest } from '../src/shared/worktree'

// The ticket spawner (#34): worktree through the worktree manager, push guard, the project's setup
// command, then the canvas - and the model and effort read back from the session that came up.
// Since Tucaen/toucan#3 `spawn` answers once the attempt is recorded; the setup command and the
// canvas settle later, in `settled`.

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

// Ticket branches are scoped to the orchestration that spawns them, so no other one's ticket 34 collides.
const branch34 = `ticket/${orchestrationBranchScope({ provider: 'claude', conversationId: 'conversation-1' })}/34`

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
    session: (nodeId) => (nodeId === 'ticket-node-1' ? { model: 'claude-opus-5-5', effort: 'high' } : undefined),
    offeredModels: () => ['claude-opus-5-5', 'claude-sonnet-5-5'],
    offeredEfforts: () => ['low', 'medium', 'high'],
    onWorktreeCreated: (path) => log.push(`registered ${path}`),
    ...overrides
  }
  return { spawner: createTicketSpawner(options), log, created, canvas, git }
}

/** Spawns, requires the attempt to be admitted, and waits for how its start settles. */
async function settle(
  spawner: TicketSpawner,
  spawnRequest: TicketSpawnRequest = request
): Promise<TicketSpawnSettlement> {
  const result = await spawner.spawn(spawnRequest)
  assert.ok(result.ok, result.ok ? '' : result.error)
  return result.settled
}

const failure = (settled: TicketSpawnSettlement): { error: string; cleanup: string } => {
  assert.ok(!settled.ok, 'the start settled ok')
  return settled
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve))

test('a spawn creates the worktree, guards it, runs setup and then starts the chat on the canvas', async () => {
  const { spawner, log, created, canvas } = harness()
  assert.deepEqual(await settle(spawner), {
    ok: true,
    session: {
      nodeId: 'ticket-node-1',
      conversationId: 'ticket-conversation-1',
      worktreePath: `D:\\project-${branch34}`,
      branch: branch34
    },
    model: 'claude-opus-5-5',
    effort: 'high',
    warnings: []
  })
  // A fresh local branch from the target branch, through the worktree manager.
  assert.deepEqual(created, [{ projectPath: 'D:\\project', branch: branch34, baseRef: 'main' }])
  // The chat starts only once the worktree is guarded and set up.
  assert.deepEqual(log, [
    `create ${branch34}`,
    `registered D:\\project-${branch34}`,
    `guard D:\\project-${branch34}`,
    `setup npm ci in D:\\project-${branch34}`,
    'canvas'
  ])
  const [started] = canvas
  assert.equal(started.projectId, 'project-1')
  assert.deepEqual(started.worktree, { path: `D:\\project-${branch34}`, branch: branch34, baseRef: 'main' })
  assert.equal(started.label, '#34 Spawn')
  assert.equal(started.modelId, 'claude-opus-5-5')
  assert.equal(started.effortId, 'high')
  // A Bypass orchestrator does not hand its mode on: the ticket session starts in the default (Auto).
  assert.equal('permissionMode' in started, false)
  assert.deepEqual(started.orchestratedBy, {
    nodeId: 'orchestrator-1',
    conversationId: 'conversation-1',
    provider: 'claude'
  })
  assert.ok(started.prompt.startsWith('/implement #34 Spawn\n\nStart one ticket session.'))
  assert.ok(started.prompt.includes(`D:\\project-${branch34}`))
})

test('a spawn answers once the attempt is recorded, before the setup command and the canvas are done', async () => {
  let finishSetup: (() => void) | undefined
  const { spawner, log } = harness({
    runSetup: (command, cwd) => {
      log.push(`setup ${command} in ${cwd}`)
      return new Promise((resolve) => (finishSetup = () => resolve({ ok: true })))
    }
  })
  const result = await spawner.spawn({
    ...request,
    onAttempt: (attempt) => void log.push(`recorded ${attempt.branch} at ${attempt.worktreePath}`)
  })
  assert.ok(result.ok)
  assert.deepEqual(result.attempt, { worktreePath: `D:\\project-${branch34}`, branch: branch34 })
  await tick()
  // Recorded after the guard, and answered with the setup command still running.
  assert.deepEqual(log, [
    `create ${branch34}`,
    `registered D:\\project-${branch34}`,
    `guard D:\\project-${branch34}`,
    `recorded ${branch34} at D:\\project-${branch34}`,
    `setup npm ci in D:\\project-${branch34}`
  ])

  finishSetup!()
  assert.equal((await result.settled).ok, true)
  assert.equal(log.at(-1), 'canvas')
})

test('an attempt that cannot be recorded fails the spawn and removes its worktree', async () => {
  const { spawner, git, log } = harness()
  const result = await spawner.spawn({
    ...request,
    onAttempt: () => {
      throw new Error('disk full')
    }
  })
  assert.ok(!result.ok)
  assert.match(result.error, /could not be recorded: disk full; the worktree and its branch were removed again/)
  assert.deepEqual(git, [
    ['worktree', 'remove', '--force', `D:\\project-${branch34}`],
    ['branch', '-D', branch34]
  ])
  assert.ok(!log.some((entry) => entry.startsWith('setup')))
})

test('a Bypass orchestrator spawns a ticket session that requests no mode, so it starts in Auto', async () => {
  const { spawner, canvas } = harness({
    // A broker snapshot still carries the orchestrator's mode; the spawner must not read it.
    session: (nodeId) =>
      (nodeId === 'orchestrator-1'
        ? { permissionMode: 'bypassPermissions' }
        : { model: 'claude-opus-5-5', effort: 'high' }) as SessionSettings
  })
  assert.ok((await settle(spawner)).ok)
  assert.equal('permissionMode' in canvas[0], false)
})

test("the ticket prompt names the main checkout's scratch folder, not the worktree's", async () => {
  const asked: string[] = []
  const { spawner, canvas } = harness({
    scratchDirectory: async (projectPath) => {
      asked.push(projectPath)
      return { ok: true, path: 'D:\\project\\.toucan-scratch' }
    }
  })
  const result = await settle(spawner)
  assert.ok(result.ok)
  assert.equal(result.warnings.length, 0)
  assert.deepEqual(asked, ['D:\\project'])
  const [started] = canvas
  assert.ok(started.prompt.includes('D:\\project\\.toucan-scratch'))
  // The ticket's own subfolder, named by orchestration scope and ticket id: no other session shares it.
  const own = `ticket-${branch34.slice('ticket/'.length).replace('/', '-')}`
  assert.ok(started.prompt.includes(`D:\\project\\.toucan-scratch\\${own}`))
  assert.ok(started.prompt.includes(`file:///D:/project/.toucan-scratch/${own}/before.png`))
  assert.ok(!started.prompt.includes(`D:\\project-${branch34}\\.toucan-scratch`))
})

test('a scratch folder that cannot be prepared is a warning, and the session starts without the sentence', async () => {
  const { spawner, canvas } = harness({
    scratchDirectory: async () => ({ ok: false, error: 'could not prepare the scratch folder (x): not a repo' })
  })
  const result = await settle(spawner)
  assert.ok(result.ok)
  assert.match(result.warnings.join(' '), /scratch folder.*not told where to save/)
  assert.ok(!canvas[0].prompt.includes('.toucan-scratch'))
})

test('a retry gets the next free branch name', async () => {
  const { spawner, created } = harness({
    worktrees: {
      async create(worktree) {
        created.push(worktree)
        if (worktree.branch === branch34) return { ok: false, conflict: true, message: 'Branch exists' }
        return { ok: true, worktree: { path: 'D:\\project-2', branch: worktree.branch, baseRef: 'main' } }
      }
    }
  })
  const result = await spawner.spawn(request)
  assert.ok(result.ok)
  assert.equal(result.attempt.branch, `${branch34}-2`)
  assert.deepEqual(
    created.map((entry) => entry.branch),
    [branch34, `${branch34}-2`]
  )
})

test('a retry past the old twenty-first name still finds a free branch', async () => {
  const taken = (branch: string): boolean => {
    const attempt = branch === branch34 ? 1 : Number(branch.slice(`${branch34}-`.length))
    return attempt <= 30
  }
  const { spawner, created } = harness({
    worktrees: {
      async create(worktree) {
        created.push(worktree)
        if (taken(worktree.branch)) return { ok: false, conflict: true, message: 'Branch exists' }
        return { ok: true, worktree: { path: 'D:\\project-31', branch: worktree.branch, baseRef: 'main' } }
      }
    }
  })
  const result = await spawner.spawn(request)
  assert.ok(result.ok)
  assert.equal(result.attempt.branch, `${branch34}-31`)
  assert.equal(created.length, 31)
})

test('Codex spawning uses its catalogue and mode, and reports confirmed settings after guard and setup', async () => {
  const { spawner, canvas, log, created } = harness({
    offeredModels: (provider) => (provider === 'codex' ? ['gpt-6', 'gpt-5.6'] : ['claude-opus-5-5']),
    offeredEfforts: (provider, model) => {
      assert.equal(provider, 'codex')
      assert.equal(model, 'gpt-6')
      return ['low', 'high', 'xhigh']
    },
    session: (nodeId) =>
      nodeId === 'orchestrator-1' ? { model: 'orchestrator-model' } : { model: 'gpt-5.6', effort: 'high' }
  })
  const codex = {
    ...request,
    orchestrator: { ...request.orchestrator, provider: 'codex' as const },
    model: 'gpt-6',
    effort: 'xhigh'
  }
  assert.equal((await spawner.spawn({ ...codex, model: 'claude-opus-5-5' })).ok, false)
  const invalidEffort = await spawner.spawn({ ...codex, effort: 'max' })
  assert.ok(!invalidEffort.ok)
  assert.match(invalidEffort.error, /effort.*not offered/)
  assert.equal(created.length, 0)
  const result = await settle(spawner, codex)
  assert.ok(result.ok)
  assert.equal(result.model, 'gpt-5.6')
  assert.equal(result.effort, 'high')
  assert.equal(result.warnings.length, 2)
  assert.equal(canvas.length, 1)
  assert.equal(canvas[0].provider, 'codex')
  assert.equal(canvas[0].orchestratedBy.provider, 'codex')
  // Codex has no Auto mode and keeps its adapter default: nothing is requested.
  assert.equal('permissionMode' in canvas[0], false)
  assert.equal(canvas[0].modelId, 'gpt-6')
  assert.equal(canvas[0].effortId, 'xhigh')
  assert.match(canvas[0].prompt, /Ticket contract/)
  assert.deepEqual(
    log.map((entry) => entry.split(' ')[0]),
    ['create', 'registered', 'guard', 'setup', 'canvas']
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
  assert.ok(!result.ok)
  assert.match(result.error, /invalid reference/)
  assert.equal(created.length, 1)
  assert.equal(canvas.length, 0)
})

test('a failing guard fails the spawn and removes the fresh worktree and its branch', async () => {
  const { spawner, canvas, git } = harness({
    installGuard: async () => ({ ok: false as const, error: 'could not install the push guard' })
  })
  const result = await spawner.spawn(request)
  assert.ok(!result.ok)
  assert.match(result.error, /push guard; the worktree and its branch were removed again/)
  assert.equal(canvas.length, 0)
  assert.deepEqual(git, [
    ['worktree', 'remove', '--force', `D:\\project-${branch34}`],
    ['branch', '-D', branch34]
  ])
})

test('a failing setup command fails the start and removes the fresh worktree and its branch', async () => {
  const { spawner, canvas, git } = harness({
    runSetup: async () => ({ ok: false as const, error: 'npm ERR! missing script' })
  })
  const failed = failure(await settle(spawner))
  assert.match(failed.error, /setup command failed: npm ERR! missing script/)
  assert.equal(failed.cleanup, 'the worktree and its branch were removed again')
  assert.equal(canvas.length, 0)
  assert.deepEqual(git, [
    ['worktree', 'remove', '--force', `D:\\project-${branch34}`],
    ['branch', '-D', branch34]
  ])
})

test('a project without a setup command starts the chat without running one and warns that setup was skipped', async () => {
  for (const setupCommand of [undefined, '  ']) {
    const { spawner, log } = harness({
      project: async () => ({ id: 'project-1', ...(setupCommand === undefined ? {} : { setupCommand }) })
    })
    const result = await settle(spawner)
    assert.ok(result.ok)
    assert.ok(!log.some((entry) => entry.startsWith('setup')))
    assert.equal(result.warnings.length, 1)
    assert.match(result.warnings[0], /no setup command/)
    assert.ok(result.warnings[0].includes(`D:\\project-${branch34}`))
  }
})

test('a model the picker does not offer is refused before anything is created', async () => {
  const { spawner, created } = harness()
  const result = await spawner.spawn({ ...request, model: 'claude-imaginary' })
  assert.ok(!result.ok)
  assert.match(result.error, /claude-imaginary.*claude-opus-5-5/)
  assert.equal(created.length, 0)
  // An empty catalogue - no Claude session has run yet - cannot refuse anything.
  const unknown = harness({ offeredModels: () => [] })
  assert.equal((await unknown.spawner.spawn({ ...request, model: 'claude-imaginary' })).ok, true)
})

test('a project Toucan does not know is refused', async () => {
  const { spawner, created } = harness({ project: async () => undefined })
  const result = await spawner.spawn(request)
  assert.ok(!result.ok)
  assert.match(result.error, /not open in Toucan/)
  assert.equal(created.length, 0)
})

test('a canvas that cannot start the chat fails the start but keeps the worktree it registered', async () => {
  const { spawner, git } = harness({
    canvas: { startTicketSession: async () => ({ ok: false, message: 'Toucan is not open on the desktop.' }) }
  })
  const failed = failure(await settle(spawner))
  assert.equal(failed.error, 'Toucan is not open on the desktop.')
  assert.equal(failed.cleanup, `the worktree stays at D:\\project-${branch34} on ${branch34}`)
  assert.deepEqual(git, [])
})

test('a session that came up on another model or effort is reported, not hidden', async () => {
  const { spawner } = harness({
    session: (nodeId) => (nodeId === 'ticket-node-1' ? { model: 'claude-sonnet-5-5', effort: 'medium' } : undefined)
  })
  const result = await settle(spawner)
  assert.ok(result.ok)
  assert.equal(result.model, 'claude-sonnet-5-5')
  assert.equal(result.effort, 'medium')
  assert.equal(result.warnings.length, 2)
  assert.match(result.warnings.join('\n'), /claude-sonnet-5-5/)
  assert.match(result.warnings.join('\n'), /medium/)
})

test('a clean-up git refuses is reported with what it left behind', async () => {
  const { spawner } = harness({
    runSetup: async () => ({ ok: false as const, error: 'npm ERR!' }),
    runGit: async () => ({ code: 128, stdout: '', stderr: 'fatal: locked' })
  })
  const failed = failure(await settle(spawner))
  assert.equal(failed.cleanup, `the worktree could not be removed and stays at D:\\project-${branch34} on ${branch34}`)
})

// Issue #1: the spawner reports the node to its caller the moment the canvas holds it, a wait that
// runs out is no verdict, and a start Toucan gives up on is stopped.

test('the session is reported as soon as the canvas holds it, before the canvas answers', async () => {
  const seen: string[] = []
  const { spawner } = harness({
    canvas: {
      async startTicketSession(_request, observer) {
        observer?.progress?.({ nodeId: 'ticket-node-1' })
        observer?.progress?.({ nodeId: 'ticket-node-1', conversationId: 'ticket-conversation-1' })
        seen.push('canvas answered')
        return { ok: true, nodeId: 'ticket-node-1', conversationId: 'ticket-conversation-1' }
      }
    }
  })
  const result = await settle(spawner, {
    ...request,
    onSession: (session) => void seen.push(`linked ${session.nodeId} ${session.conversationId ?? '-'}`)
  })
  assert.ok(result.ok)
  assert.deepEqual(
    seen.filter((entry) => entry.startsWith('linked')),
    ['linked ticket-node-1 -', 'linked ticket-node-1 ticket-conversation-1']
  )
})

test('the start wait the caller names reaches the canvas', async () => {
  let timeoutMs: number | undefined
  const { spawner } = harness({
    canvas: {
      async startTicketSession(_request, observer) {
        timeoutMs = observer?.timeoutMs
        return { ok: true, nodeId: 'ticket-node-1', conversationId: 'ticket-conversation-1' }
      }
    }
  })
  await settle(spawner, { ...request, startTimeoutMs: 600_000 })
  assert.equal(timeoutMs, 600_000)
})

test("a canvas wait that ran out with the node on the canvas is waited out, and settles on the window's verdict", async () => {
  const cancelled: string[] = []
  let late: ((result: TicketSessionCanvasResult) => void) | undefined
  const { spawner } = harness({
    canvas: {
      async startTicketSession(_request, observer) {
        observer?.progress?.({ nodeId: 'ticket-node-1', conversationId: 'ticket-conversation-1' })
        late = observer?.late
        return { ok: false, pending: true, message: 'still starting', nodeId: 'ticket-node-1' }
      },
      cancelTicketSession: (nodeId) => void cancelled.push(nodeId)
    }
  })
  const result = await spawner.spawn(request)
  assert.ok(result.ok)
  let settled: TicketSpawnSettlement | undefined
  void result.settled.then((outcome) => (settled = outcome))
  await tick()
  // A slow start is no failure: nothing is stopped and nothing has settled.
  assert.equal(settled, undefined)
  assert.deepEqual(cancelled, [])

  late!({ ok: true, nodeId: 'ticket-node-1', conversationId: 'ticket-conversation-1' })
  assert.deepEqual(await result.settled, {
    ok: true,
    session: {
      nodeId: 'ticket-node-1',
      conversationId: 'ticket-conversation-1',
      worktreePath: `D:\\project-${branch34}`,
      branch: branch34
    },
    model: 'claude-opus-5-5',
    effort: 'high',
    warnings: []
  })
})

test("a window answer that beats the canvas's timed-out answer is still the verdict", async () => {
  const cancelled: string[] = []
  const { spawner } = harness({
    canvas: {
      async startTicketSession(_request, observer) {
        observer?.progress?.({ nodeId: 'ticket-node-1', conversationId: 'ticket-conversation-1' })
        // The window answers in the same tick the wait runs out.
        observer?.late?.({ ok: true, nodeId: 'ticket-node-1', conversationId: 'ticket-conversation-1' })
        return { ok: false, pending: true, message: 'still starting', nodeId: 'ticket-node-1' }
      },
      cancelTicketSession: (nodeId) => void cancelled.push(nodeId)
    }
  })
  assert.ok((await settle(spawner)).ok)
  assert.deepEqual(cancelled, [])
})

test('a start that fails after the wait ran out is reported failed, its node kept for the human', async () => {
  let late: ((result: TicketSessionCanvasResult) => void) | undefined
  const { spawner } = harness({
    canvas: {
      async startTicketSession(_request, observer) {
        observer?.progress?.({ nodeId: 'ticket-node-1' })
        late = observer?.late
        return { ok: false, pending: true, message: 'still starting', nodeId: 'ticket-node-1' }
      }
    }
  })
  const result = await spawner.spawn(request)
  assert.ok(result.ok)
  await tick()
  late!({ ok: false, message: 'The ticket session could not be started on the desktop.' })
  const failed = failure(await result.settled)
  assert.equal(failed.error, 'The ticket session could not be started on the desktop.')
  assert.match(failed.cleanup, /worktree stays at .*, and its node stays on the canvas without the ticket prompt$/)
})

test('a session that cannot be recorded is stopped and fails the start', async () => {
  const cancelled: string[] = []
  const { spawner } = harness({
    canvas: {
      async startTicketSession(_request, observer) {
        observer?.progress?.({ nodeId: 'ticket-node-1' })
        return { ok: true, nodeId: 'ticket-node-1', conversationId: 'ticket-conversation-1' }
      },
      cancelTicketSession: (nodeId) => void cancelled.push(nodeId)
    }
  })
  const failed = failure(
    await settle(spawner, {
      ...request,
      onSession: () => {
        throw new Error('disk full')
      }
    })
  )
  assert.match(failed.error, /disk full/)
  assert.match(failed.cleanup, /Toucan closed its session/)
  assert.deepEqual(cancelled, ['ticket-node-1'])
})

test('a canvas that throws after reporting the node stops that node', async () => {
  const cancelled: string[] = []
  const { spawner } = harness({
    canvas: {
      async startTicketSession(_request, observer) {
        observer?.progress?.({ nodeId: 'ticket-node-1' })
        throw new Error('ipc closed')
      },
      cancelTicketSession: (nodeId) => void cancelled.push(nodeId)
    }
  })
  assert.match(failure(await settle(spawner)).error, /ipc closed/)
  assert.deepEqual(cancelled, ['ticket-node-1'])
})

test('a late start the canvas gave up on without a node is withdrawn rather than left working', async () => {
  const cancelled: string[] = []
  let late: ((result: TicketSessionCanvasResult) => void) | undefined
  const { spawner } = harness({
    canvas: {
      async startTicketSession(_request, observer) {
        late = observer?.late
        return { ok: false, message: 'The Toucan window closed before the ticket session was started.' }
      },
      cancelTicketSession: (nodeId) => void cancelled.push(nodeId)
    }
  })
  failure(await settle(spawner))
  late!({ ok: true, nodeId: 'ticket-node-9', conversationId: 'c' })
  assert.deepEqual(cancelled, ['ticket-node-9'])
})

// Tucaen/toucan#3: an attempt replaced or discarded while it starts is cancelled.

test('a start cancelled during setup stops the setup and never asks the canvas', async () => {
  let signal: AbortSignal | undefined
  const { spawner, canvas, git } = harness({
    runSetup: (_command, _cwd, abort) => {
      signal = abort
      return new Promise((resolve) =>
        abort?.addEventListener('abort', () => resolve({ ok: false, error: '"npm ci" was cancelled' }))
      )
    }
  })
  const result = await spawner.spawn(request)
  assert.ok(result.ok)
  await tick()
  result.cancel()
  assert.equal(signal?.aborted, true)
  const settled = await result.settled
  assert.ok(!settled.ok)
  assert.equal(settled.cancelled, true)
  assert.equal(canvas.length, 0)
  // Its worktree is left to whoever cancelled it.
  assert.deepEqual(git, [])
})

test('a start cancelled once the canvas holds its node closes that node', async () => {
  const cancelled: string[] = []
  let late: ((result: TicketSessionCanvasResult) => void) | undefined
  const { spawner } = harness({
    canvas: {
      async startTicketSession(_request, observer) {
        observer?.progress?.({ nodeId: 'ticket-node-1' })
        late = observer?.late
        return { ok: false, pending: true, message: 'still starting', nodeId: 'ticket-node-1' }
      },
      cancelTicketSession: (nodeId) => void cancelled.push(nodeId)
    }
  })
  const result = await spawner.spawn(request)
  assert.ok(result.ok)
  await tick()
  result.cancel()
  assert.deepEqual(cancelled, ['ticket-node-1'])
  late!({ ok: false, message: 'closed' })
  const settled = await result.settled
  assert.ok(!settled.ok)
  assert.equal(settled.cancelled, true)
})

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { createFirstMateRuntime } from '../src/main/firstmate-runtime'
import {
  firstMateRequest,
  firstMateProjectCatalog,
  type FirstMateRequestProject
} from '../src/renderer/src/firstmate-project-catalog'
import {
  firstMateTaskContextFromMetadata,
  firstMateTaskContextMetadata,
  type FirstMateTaskContext
} from '../src/shared/firstmate-task-context'
import { createFirstMateLifecycleCoordinator } from '../src/main/firstmate-lifecycle-coordinator'
import {
  firstMateSpawnContextProblem,
  type FirstMateSpawnGateProject,
  type FirstMateSpawnGateValidator
} from '../src/main/firstmate-spawn-gate'
import {
  firstMateLifecycleFromFiles,
  firstMateValidationDispatchId,
  type FirstMateLifecycleJournal,
  type FirstMateLifecycleRecord,
  type FirstMateRawTask
} from '../src/main/firstmate-lifecycle'
import type {
  FirstMateProjectCatalog,
  FirstMateProjectCatalogEntry,
  FirstMateProjectRegistration,
  FirstMateValidationDelivery
} from '../src/shared/firstmate'
import type { WorkspaceProject } from '../src/shared/terminal'
import { createGitCrew, gitIdentity, gitProvenance, type GitCrew } from './firstmate-git-crew'
import { firstMateCatalogFromRequest } from './firstmate-catalog-test-helpers'

// --- Shared helpers ---

function readyWslInspection(): string {
  return [
    'home=/home/tucaen',
    'distro=1',
    'runner.codex=1',
    'runner.claude=1',
    ...['node', 'git', 'gh', 'tmux', 'jq', 'claude', 'codex', 'treehouse', 'no-mistakes', 'gh-axi',
      'chrome-devtools-axi', 'lavish-axi', 'tasks-axi', 'quota-axi'].map((tool) => `tool.${tool}=1`),
    'wrapper.claude=1',
    'wrapper.codex=1',
    'daemon.no-mistakes=1',
    'githubAuth=required',
    'codexTrust=required'
  ].join('\n')
}

function testWslPath(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  const match = /^([a-zA-Z]):\/(.*)$/.exec(normalized)
  assert.ok(match)
  return `/mnt/${match[1]!.toLocaleLowerCase()}/${match[2]}`
}

interface E2eWslHost {
  files: { store?: string; registry?: string }
  calls: string[][]
  run(args: string[]): Promise<{ stdout: string; stderr: string }>
}

function e2eWslHost(options: {
  registry?: string
  access?(): { accessible: boolean; message?: string }
}): E2eWslHost {
  const host: E2eWslHost = {
    files: { ...(options.registry === undefined ? {} : { registry: options.registry }) },
    calls: [],
    async run(args: string[]) {
      host.calls.push(args)
      if (args[3] === '/bin/sh') return { stdout: readyWslInspection(), stderr: '' }
      const script = args[5] ?? ''
      if (script.includes('statSync(project)')) {
        return { stdout: JSON.stringify(options.access?.() ?? { accessible: true }), stderr: '' }
      }
      if (script.includes('renameSync')) {
        host.files.store = Buffer.from(args.at(-1) ?? '', 'base64url').toString('utf8')
        return { stdout: '', stderr: '' }
      }
      return { stdout: JSON.stringify(host.files), stderr: '' }
    }
  }
  return host
}

function workspaceProject(id: string, name: string, path: string): WorkspaceProject {
  return { id, name, path, color: '#71a9ff' }
}

function requestProject(
  ws: WorkspaceProject,
  registration: FirstMateProjectRegistration
): FirstMateRequestProject {
  return { selection: ws, registration }
}

function spawnGateProject(reg: NonNullable<FirstMateProjectRegistration['project']>): FirstMateSpawnGateProject {
  return {
    adeProjectId: reg.adeProjectId,
    registryName: reg.registryName,
    windowsPath: reg.windowsPath,
    wslPath: reg.wslPath,
    mode: reg.mode,
    autonomy: reg.autonomy
  }
}

/**
 * Simulates what the FirstMate captain does: selects a project from the catalog by id, reads its
 * taskContextMetadata carrier, and constructs the raw task metadata FirstMate writes to state/<id>.meta.
 * The test authors the captain-owned fields (kind, mode, yolo, project, worktree, harness, model) but
 * must use the ADE-produced carrier verbatim — never hand-building the ade_task_context value.
 */
function fakeCaptainTask(
  catalog: FirstMateProjectCatalog,
  projectId: string,
  taskId: string,
  worktreeWsl: string,
  kind: 'ship' | 'scout'
): { task: FirstMateRawTask; context: FirstMateTaskContext; entry: FirstMateProjectCatalogEntry } {
  const entry = catalog.projects.find((p) => p.adeProjectId === projectId)
  assert.ok(entry, `catalog must contain project ${projectId}`)
  const context = firstMateTaskContextFromMetadata(entry.taskContextMetadata)
  assert.ok(context, `catalog entry for ${projectId} must carry a parseable task context`)

  const resolvedMode = context.project.mode === 'no-mistakes-prod-only' ? 'no-mistakes' : context.project.mode
  const metaLines = kind === 'ship'
    ? [
        `kind=${kind}`,
        `mode=${resolvedMode}`,
        `yolo=${context.project.autonomy ? 'on' : 'off'}`,
        `project=${context.project.wslPath}`,
        `worktree=${worktreeWsl}`,
        `harness=${context.validator.agent}`,
        ...(context.validator.model !== 'default' ? [`model=${context.validator.model}`] : []),
        entry.taskContextMetadata
      ]
    : [
        `kind=${kind}`,
        `project=${context.project.wslPath}`,
        `worktree=${worktreeWsl}`,
        `harness=${context.validator.agent}`,
        ...(context.validator.model !== 'default' ? [`model=${context.validator.model}`] : []),
        entry.taskContextMetadata
      ]

  return {
    task: {
      id: taskId,
      meta: metaLines.join('\n'),
      status: kind === 'ship'
        ? `done: committed ${projectId} implementation\n`
        : `done: report data/${taskId}/report.md\n`
    },
    context,
    entry
  }
}

// --- Registration ---

interface ProjectSpec {
  id: string
  name: string
  crew: GitCrew
  origin?: string
}

async function registerProjects(options: {
  projects: ProjectSpec[]
  registry?: string
}): Promise<{
  registrations: Map<string, FirstMateProjectRegistration>
  host: E2eWslHost
}> {
  const host = e2eWslHost({ registry: options.registry })
  const origins = new Map(options.projects.map((p) => [
    p.crew.primary.toLocaleLowerCase(),
    p.origin
  ]))
  const runtime = createFirstMateRuntime({
    platform: 'win32',
    resolveGit: () => 'git.exe',
    inspectCheckout: async (windowsPath) => {
      const key = windowsPath.toLocaleLowerCase()
      if (!origins.has(key)) return { status: 'missing' as const }
      const origin = origins.get(key)
      return origin
        ? { status: 'git-checkout' as const, origin }
        : { status: 'git-checkout' as const }
    },
    wsl: { run: host.run }
  })
  await runtime.status()
  const registrations = new Map<string, FirstMateProjectRegistration>()
  for (const project of options.projects) {
    const reg = await runtime.registerProject({
      projectId: project.id, name: project.name, path: project.crew.primary
    })
    registrations.set(project.id, reg)
  }
  return { registrations, host }
}

// --- Tests ---

test('registers two real external Git checkouts through the production registration path', async () => {
  const alphaCrew = createGitCrew('alpha')
  const betaCrew = createGitCrew('beta')

  const { registrations, host } = await registerProjects({
    projects: [
      { id: 'alpha', name: 'Api', crew: alphaCrew, origin: 'https://github.com/acme/alpha.git' },
      { id: 'beta', name: 'Scratch', crew: betaCrew }
    ]
  })
  const alphaReg = registrations.get('alpha')!
  const betaReg = registrations.get('beta')!

  assert.equal(alphaReg.ok, true)
  assert.ok(alphaReg.project)
  assert.equal(alphaReg.project.adeProjectId, 'alpha')
  assert.equal(alphaReg.project.originClassification, 'remote-backed')
  assert.equal(alphaReg.project.mode, 'no-mistakes-prod-only')
  assert.equal(alphaReg.project.initialization, 'required')
  assert.equal(alphaReg.project.windowsPath, alphaCrew.primary)
  assert.equal(alphaReg.project.wslPath, testWslPath(alphaCrew.primary))

  assert.equal(betaReg.ok, true)
  assert.ok(betaReg.project)
  assert.equal(betaReg.project.adeProjectId, 'beta')
  assert.equal(betaReg.project.originClassification, 'local-only')
  assert.equal(betaReg.project.mode, 'local-only')
  assert.equal(betaReg.project.initialization, 'not-required')
  assert.equal(betaReg.project.windowsPath, betaCrew.primary)

  const store = JSON.parse(host.files.store ?? '{}')
  assert.equal(store.version, 1)
  assert.ok(store.projects.alpha)
  assert.ok(store.projects.beta)

  const restartedRuntime = createFirstMateRuntime({
    platform: 'win32',
    resolveGit: () => 'git.exe',
    wsl: { run: host.run }
  })
  assert.deepEqual(await restartedRuntime.recordedProject('alpha'), alphaReg.project)
  assert.deepEqual(await restartedRuntime.recordedProject('beta'), betaReg.project)
})

test('sidebar hint A resolves to project B and a second request creates coordinated tasks across both projects', async () => {
  const alphaCrew = createGitCrew('alpha')
  const betaCrew = createGitCrew('beta')
  const { registrations } = await registerProjects({
    projects: [
      { id: 'alpha', name: 'Api', crew: alphaCrew, origin: 'https://github.com/acme/alpha.git' },
      { id: 'beta', name: 'Scratch', crew: betaCrew }
    ]
  })
  const alphaReg = registrations.get('alpha')!
  const betaReg = registrations.get('beta')!
  assert.ok(alphaReg.project)
  assert.ok(betaReg.project)

  const alphaWs = workspaceProject('alpha', 'Api', alphaCrew.primary)
  const betaWs = workspaceProject('beta', 'Scratch', betaCrew.primary)

  // Request 1: sidebar hint is alpha, but captain resolves to beta
  const prompt1 = firstMateRequest(
    [requestProject(alphaWs, alphaReg), requestProject(betaWs, betaReg)],
    'alpha',
    'Fix the scratch project',
    { provider: 'codex', model: 'gpt-5.6-sol' }
  )
  const catalog1 = firstMateCatalogFromRequest(prompt1)
  assert.equal(catalog1.activeProjectHint.adeProjectId, 'alpha')
  assert.equal(catalog1.activeProjectHint.role, 'hint-only')

  const betaEntry = catalog1.projects.find((p) => p.adeProjectId === 'beta')
  assert.ok(betaEntry, 'beta must be in the catalog despite not being the hint')
  const betaContext = firstMateTaskContextFromMetadata(betaEntry.taskContextMetadata)
  assert.ok(betaContext)
  assert.equal(betaContext.project.adeProjectId, 'beta')
  assert.equal(betaContext.validator.agent, 'codex')

  const gateProblem = firstMateSpawnContextProblem(
    betaContext,
    spawnGateProject(betaReg.project),
    catalog1.validator
  )
  assert.equal(gateProblem, undefined, 'a non-hint project selected by the captain must pass the spawn gate')

  // Request 2: captain dispatches tasks to both projects
  const prompt2 = firstMateRequest(
    [requestProject(alphaWs, alphaReg), requestProject(betaWs, betaReg)],
    'alpha',
    'Update both the API and scratch',
    { provider: 'codex', model: 'gpt-5.6-sol' }
  )
  const catalog2 = firstMateCatalogFromRequest(prompt2)
  const alphaCtx = firstMateTaskContextFromMetadata(
    catalog2.projects.find((p) => p.adeProjectId === 'alpha')!.taskContextMetadata
  )
  const betaCtx = firstMateTaskContextFromMetadata(
    catalog2.projects.find((p) => p.adeProjectId === 'beta')!.taskContextMetadata
  )
  assert.ok(alphaCtx)
  assert.ok(betaCtx)
  assert.notEqual(alphaCtx.project.adeProjectId, betaCtx.project.adeProjectId)
  assert.equal(
    firstMateSpawnContextProblem(alphaCtx, spawnGateProject(alphaReg.project), catalog2.validator),
    undefined
  )
  assert.equal(
    firstMateSpawnContextProblem(betaCtx, spawnGateProject(betaReg.project), catalog2.validator),
    undefined
  )
})

test('ship and scout paths with both providers pass the catalog-to-spawn-gate contract', async () => {
  const alphaCrew = createGitCrew('alpha')
  const betaCrew = createGitCrew('beta')
  const { registrations } = await registerProjects({
    projects: [
      { id: 'alpha', name: 'Api', crew: alphaCrew, origin: 'https://github.com/acme/alpha.git' },
      { id: 'beta', name: 'Scratch', crew: betaCrew }
    ]
  })
  const alphaReg = registrations.get('alpha')!
  const betaReg = registrations.get('beta')!
  assert.ok(alphaReg.project)
  assert.ok(betaReg.project)

  const alphaWs = workspaceProject('alpha', 'Api', alphaCrew.primary)
  const betaWs = workspaceProject('beta', 'Scratch', betaCrew.primary)

  const matrix: Array<{ provider: 'codex' | 'claude'; model: string; kind: 'ship' | 'scout'; projectId: string }> = [
    { provider: 'codex', model: 'gpt-5.6-sol', kind: 'ship', projectId: 'alpha' },
    { provider: 'claude', model: 'claude-sonnet-4-5', kind: 'ship', projectId: 'alpha' },
    { provider: 'codex', model: 'gpt-5.6-sol', kind: 'scout', projectId: 'beta' },
    { provider: 'claude', model: 'claude-sonnet-4-5', kind: 'scout', projectId: 'beta' }
  ]

  for (const { provider, model, kind, projectId } of matrix) {
    const catalog = firstMateProjectCatalog(
      [requestProject(alphaWs, alphaReg), requestProject(betaWs, betaReg)],
      'alpha',
      { provider, model }
    )

    const entry = catalog.projects.find((p) => p.adeProjectId === projectId)
    assert.ok(entry, `${projectId} must be in the catalog for ${provider}/${kind}`)
    const context = firstMateTaskContextFromMetadata(entry.taskContextMetadata)
    assert.ok(context, `parseable context for ${provider}/${kind}`)
    assert.equal(context.validator.agent, provider)
    assert.equal(context.validator.model, model)

    const reg = projectId === 'alpha' ? alphaReg : betaReg
    assert.equal(
      firstMateSpawnContextProblem(context, spawnGateProject(reg.project!), catalog.validator),
      undefined,
      `${kind} with ${provider} on ${projectId} must pass the spawn gate`
    )

    // Verify the fake captain can produce valid raw task metadata from this entry
    const worktreeWsl = `/home/tucaen/.treehouse/${projectId}/${kind}-task`
    const { task, context: taskContext } = fakeCaptainTask(catalog, projectId, `${projectId}-${kind}`, worktreeWsl, kind)
    assert.equal(taskContext.project.adeProjectId, projectId)
    assert.equal(taskContext.validator.agent, provider)

    // The raw task must round-trip through lifecycle parsing
    const lifecycle = firstMateLifecycleFromFiles({ tasks: [task] })
    assert.equal(lifecycle.tasks.length, 1, `${kind}/${provider} task must survive lifecycle parsing`)
    assert.deepEqual(lifecycle.tasks[0]!.context, taskContext)
    if (kind === 'ship') {
      assert.equal(lifecycle.tasks[0]!.stage, 'implemented')
      assert.equal(lifecycle.tasks[0]!.nextAction, 'start-validation')
    } else {
      assert.equal(lifecycle.tasks[0]!.mode, 'scout')
      assert.equal(lifecycle.tasks[0]!.stage, 'implemented')
      assert.equal(lifecycle.tasks[0]!.nextAction, undefined, 'scouts do not enter validation')
    }
  }
})

test('concurrent crews use distinct worktrees proven to belong to their selected repositories', async () => {
  const alphaCrew = createGitCrew('alpha')
  const betaCrew = createGitCrew('beta')
  const { registrations } = await registerProjects({
    projects: [
      { id: 'alpha', name: 'Api', crew: alphaCrew, origin: 'https://github.com/acme/alpha.git' },
      { id: 'beta', name: 'Scratch', crew: betaCrew }
    ]
  })
  const alphaReg = registrations.get('alpha')!
  const betaReg = registrations.get('beta')!
  assert.ok(alphaReg.project)
  assert.ok(betaReg.project)

  const alphaWs = workspaceProject('alpha', 'Api', alphaCrew.primary)
  const betaWs = workspaceProject('beta', 'Scratch', betaCrew.primary)

  const catalog = firstMateProjectCatalog(
    [requestProject(alphaWs, alphaReg), requestProject(betaWs, betaReg)],
    'alpha',
    { provider: 'codex', model: 'gpt-5.6-sol' }
  )
  const alphaTask = fakeCaptainTask(catalog, 'alpha', 'alpha-ship', testWslPath(alphaCrew.worktree), 'ship')
  const betaTask = fakeCaptainTask(catalog, 'beta', 'beta-ship', testWslPath(betaCrew.worktree), 'ship')

  // Each crew worktree must derive from its pinned checkout
  assert.equal(
    gitIdentity(alphaCrew.worktree).commonDir.toLocaleLowerCase(),
    gitIdentity(alphaCrew.primary).commonDir.toLocaleLowerCase(),
    'alpha crew worktree must share its checkout common dir'
  )
  assert.equal(
    gitIdentity(betaCrew.worktree).commonDir.toLocaleLowerCase(),
    gitIdentity(betaCrew.primary).commonDir.toLocaleLowerCase(),
    'beta crew worktree must share its checkout common dir'
  )

  // Worktrees must be distinct from each other and from the primary checkouts
  assert.notEqual(
    alphaCrew.worktree.toLocaleLowerCase(),
    betaCrew.worktree.toLocaleLowerCase(),
    'each crew must use its own worktree'
  )

  // Provenance must pass for correct pairings
  const alphaProvenance = gitProvenance(alphaCrew.worktree, alphaCrew.primary)
  const betaProvenance = gitProvenance(betaCrew.worktree, betaCrew.primary)
  const alphaLifecycle = firstMateLifecycleFromFiles({
    tasks: [{ ...alphaTask.task, provenance: alphaProvenance }]
  })
  const betaLifecycle = firstMateLifecycleFromFiles({
    tasks: [{ ...betaTask.task, provenance: betaProvenance }]
  })
  assert.equal(alphaLifecycle.tasks[0]?.stage, 'implemented', 'valid alpha provenance must be accepted')
  assert.equal(betaLifecycle.tasks[0]?.stage, 'implemented', 'valid beta provenance must be accepted')

  // Cross-wired provenance must be rejected
  const crossWired = firstMateLifecycleFromFiles({
    tasks: [{ ...alphaTask.task, provenance: gitProvenance(betaCrew.worktree, alphaCrew.primary) }]
  })
  assert.equal(crossWired.tasks[0]?.stage, 'blocked', 'a worktree from a foreign repository must be blocked')
  assert.match(crossWired.tasks[0]?.detail ?? '', /foreign repository/i)

  // Primary checkout reported as a worktree must be rejected
  const primaryAsWorktree = firstMateLifecycleFromFiles({
    tasks: [{ ...alphaTask.task, provenance: gitProvenance(alphaCrew.primary, alphaCrew.primary) }]
  })
  assert.equal(primaryAsWorktree.tasks[0]?.stage, 'blocked', 'primary checkout used as crew must be blocked')
})

test('multi-project lifecycle: dispatch, provider switch, restart, validation scoping, wakes, and idempotent recovery', async () => {
  const alphaCrew = createGitCrew('alpha')
  const betaCrew = createGitCrew('beta')
  // Both projects are remote-backed so both enter no-mistakes validation
  const { registrations } = await registerProjects({
    projects: [
      { id: 'alpha', name: 'Api', crew: alphaCrew, origin: 'https://github.com/acme/alpha.git' },
      { id: 'beta', name: 'Web', crew: betaCrew, origin: 'https://github.com/acme/beta.git' }
    ]
  })
  const alphaReg = registrations.get('alpha')!
  const betaReg = registrations.get('beta')!
  assert.ok(alphaReg.project)
  assert.ok(betaReg.project)

  const alphaWs = workspaceProject('alpha', 'Api', alphaCrew.primary)
  const betaWs = workspaceProject('beta', 'Web', betaCrew.primary)

  // Request 1 with codex: captain dispatches alpha-ship
  const catalog1 = firstMateProjectCatalog(
    [requestProject(alphaWs, alphaReg), requestProject(betaWs, betaReg)],
    'alpha',
    { provider: 'codex', model: 'gpt-5.6-sol' }
  )
  const alphaDispatch = fakeCaptainTask(catalog1, 'alpha', 'alpha-ship', testWslPath(alphaCrew.worktree), 'ship')
  assert.equal(alphaDispatch.context.validator.agent, 'codex')

  // Request 2 with claude (global provider switch): captain dispatches beta-ship
  const catalog2 = firstMateProjectCatalog(
    [requestProject(alphaWs, alphaReg), requestProject(betaWs, betaReg)],
    'beta',
    { provider: 'claude', model: 'claude-sonnet-4-5' }
  )
  const betaDispatch = fakeCaptainTask(catalog2, 'beta', 'beta-ship', testWslPath(betaCrew.worktree), 'ship')
  assert.equal(betaDispatch.context.validator.agent, 'claude')

  const rawTasks = [alphaDispatch.task, betaDispatch.task]
  let journal: FirstMateLifecycleJournal = { version: 1, tasks: {} }
  let mutableGlobalConfig = JSON.stringify({
    version: 1,
    validator: { agent: 'claude', model: 'claude-sonnet-4-5' }
  })
  const sends: string[][] = []
  const pipelineWrites = new Map<string, string>()
  const wakes: string[] = []

  const run = async (args: string[]): Promise<{ stdout: string; stderr: string }> => {
    if (args.includes('-lc')) return { stdout: readyWslInspection(), stderr: '' }
    if (args.includes('ade-firstmate-validator')) {
      const marker = args.indexOf('ade-firstmate-validator')
      mutableGlobalConfig = JSON.stringify({
        version: 1,
        validator: { agent: args[marker + 2], model: args[marker + 3] }
      })
      return { stdout: '', stderr: '' }
    }
    const scriptIndex = args.indexOf('-e')
    const script = scriptIndex >= 0 ? args[scriptIndex + 1] ?? '' : ''
    if (script.includes("names.filter((name) => name.endsWith('.meta'))")) {
      return {
        stdout: JSON.stringify({
          runtimeConfig: mutableGlobalConfig,
          journal: JSON.stringify(journal),
          tasks: rawTasks
        }),
        stderr: ''
      }
    }
    if (script.includes('journal.tasks[taskId] = record')) {
      const taskId = args.at(-2) ?? ''
      const record = JSON.parse(Buffer.from(args.at(-1) ?? '', 'base64url').toString('utf8')) as FirstMateLifecycleRecord
      journal = { version: 1, tasks: { ...journal.tasks, [taskId]: record } }
      return { stdout: '', stderr: '' }
    }
    if (args.some((arg) => arg.endsWith('/bin/fm-send.sh'))) {
      sends.push(args)
      return { stdout: '', stderr: '' }
    }
    const nmConfigPath = args.find((arg) => /\/no-mistakes\/config\.yaml$/.test(arg))
    if (nmConfigPath) {
      pipelineWrites.set(nmConfigPath, Buffer.from(args.at(-1) ?? '', 'base64url').toString('utf8'))
      return { stdout: '', stderr: '' }
    }
    return { stdout: '', stderr: '' }
  }

  const runtimeOptions = {
    platform: 'win32' as const,
    resolveGit: () => 'git.exe',
    wsl: { run }
  }
  const runtime = createFirstMateRuntime(runtimeOptions)
  await runtime.status()
  const coordinator = createFirstMateLifecycleCoordinator({
    runtime,
    wakeCaptain: async (message) => { wakes.push(message); return { ok: true } }
  })

  // First poll: both tasks dispatch concurrently with their pinned providers
  await coordinator.poll()

  assert.equal(sends.length, 2, 'both pinned providers must dispatch concurrently in a single poll')
  const alphaShipSend = sends.find((args) => args.includes('alpha-ship'))
  assert.ok(alphaShipSend, 'alpha-ship must dispatch')
  assert.ok(alphaShipSend.includes('ADE_FIRSTMATE_VALIDATOR_AGENT=codex'))
  assert.ok(alphaShipSend.includes('ADE_FIRSTMATE_VALIDATOR_MODEL=gpt-5.6-sol'))
  assert.match(alphaShipSend.at(-1) ?? '', /^\$no-mistakes/, 'codex tasks invoke $no-mistakes')

  const betaShipSend = sends.find((args) => args.includes('beta-ship'))
  assert.ok(betaShipSend, 'beta-ship must dispatch')
  assert.ok(betaShipSend.includes('ADE_FIRSTMATE_VALIDATOR_AGENT=claude'))
  assert.ok(betaShipSend.includes('ADE_FIRSTMATE_VALIDATOR_MODEL=claude-sonnet-4-5'))
  assert.match(betaShipSend.at(-1) ?? '', /^\/no-mistakes/, 'claude tasks invoke /no-mistakes')

  // Concurrent tasks must get distinct NM_HOME scopes
  const alphaNmHome = alphaShipSend.find((arg) => arg.startsWith('NM_HOME='))
  const betaNmHome = betaShipSend.find((arg) => arg.startsWith('NM_HOME='))
  assert.ok(alphaNmHome)
  assert.ok(betaNmHome)
  assert.notEqual(alphaNmHome, betaNmHome, 'each task must get its own NM_HOME')
  assert.match(alphaNmHome, /\/state\/validators\/[a-f0-9]{20}\/no-mistakes$/)
  assert.match(betaNmHome, /\/state\/validators\/[a-f0-9]{20}\/no-mistakes$/)

  // Pipeline configs must be distinct and reference the correct providers
  assert.equal(pipelineWrites.size, 2, 'each task must write its own pipeline config')
  const alphaConfig = [...pipelineWrites.values()].find((config) => config.includes('agent: codex'))
  const betaConfig = [...pipelineWrites.values()].find((config) => config.includes('agent: claude'))
  assert.ok(alphaConfig, 'alpha pipeline config must select codex')
  assert.ok(betaConfig, 'beta pipeline config must select claude')

  // Change the global provider and restart
  await runtime.configureValidator('codex', 'global-after-dispatch')
  const restartedRuntime = createFirstMateRuntime(runtimeOptions)
  await restartedRuntime.status()
  sends.length = 0

  const restartedCoordinator = createFirstMateLifecycleCoordinator({
    runtime: restartedRuntime,
    wakeCaptain: async (message) => { wakes.push(message); return { ok: true } }
  })

  // Second poll after restart: acknowledged dispatches must not repeat
  await restartedCoordinator.poll()
  assert.equal(sends.length, 0, 'restart must not re-dispatch acknowledged tasks')

  // Complete the tasks with PR URLs
  rawTasks[0]!.status += 'done: PR https://github.com/acme/alpha/pull/10 checks green\n'
  rawTasks[1]!.status += 'done: PR https://github.com/acme/beta/pull/20 checks green\n'
  wakes.length = 0
  await restartedCoordinator.poll()

  const lifecycle = await restartedRuntime.lifecycle()
  const completedAlpha = lifecycle.tasks.find((t) => t.id === 'alpha-ship')
  const completedBeta = lifecycle.tasks.find((t) => t.id === 'beta-ship')

  assert.ok(completedAlpha)
  assert.equal(completedAlpha.stage, 'pr-ready')
  assert.equal(completedAlpha.prUrl, 'https://github.com/acme/alpha/pull/10')
  assert.equal(completedAlpha.context?.project.adeProjectId, 'alpha')
  assert.equal(completedAlpha.context?.validator.agent, 'codex')
  assert.equal(completedAlpha.context?.validator.model, 'gpt-5.6-sol')

  assert.ok(completedBeta)
  assert.equal(completedBeta.stage, 'pr-ready')
  assert.equal(completedBeta.prUrl, 'https://github.com/acme/beta/pull/20')
  assert.equal(completedBeta.context?.project.adeProjectId, 'beta')
  assert.equal(completedBeta.context?.validator.agent, 'claude')
  assert.equal(completedBeta.context?.validator.model, 'claude-sonnet-4-5')

  // Wake must name both tasks with their pinned providers
  const prWake = wakes.find((msg) => /alpha-ship=pr-ready/.test(msg))
  assert.ok(prWake, 'completion must wake the captain')
  assert.match(prWake, /project=alpha[\s\S]*validator=codex\/gpt-5\.6-sol/)
  assert.match(prWake, /project=beta[\s\S]*validator=claude\/claude-sonnet-4-5/)
})

test('retrying a logical validation dispatch does not start validation twice', async () => {
  const alphaCrew = createGitCrew('alpha')
  const betaCrew = createGitCrew('beta')
  const { registrations } = await registerProjects({
    projects: [
      { id: 'alpha', name: 'Api', crew: alphaCrew, origin: 'https://github.com/acme/alpha.git' },
      { id: 'beta', name: 'Web', crew: betaCrew, origin: 'https://github.com/acme/beta.git' }
    ]
  })
  const alphaReg = registrations.get('alpha')!
  const betaReg = registrations.get('beta')!
  assert.ok(alphaReg.project)
  assert.ok(betaReg.project)

  const alphaWs = workspaceProject('alpha', 'Api', alphaCrew.primary)
  const betaWs = workspaceProject('beta', 'Web', betaCrew.primary)

  const catalog = firstMateProjectCatalog(
    [requestProject(alphaWs, alphaReg), requestProject(betaWs, betaReg)],
    'alpha',
    { provider: 'codex', model: 'gpt-5.6-sol' }
  )
  const dispatch = fakeCaptainTask(catalog, 'alpha', 'alpha-ship', testWslPath(alphaCrew.worktree), 'ship')
  const rawTasks = [dispatch.task]
  let journal: FirstMateLifecycleJournal = { version: 1, tasks: {} }
  const started = new Set<string>()
  let validationStarts = 0

  const run = async (args: string[]): Promise<{ stdout: string; stderr: string }> => {
    if (args.includes('-lc')) return { stdout: readyWslInspection(), stderr: '' }
    const scriptIndex = args.indexOf('-e')
    const script = scriptIndex >= 0 ? args[scriptIndex + 1] ?? '' : ''
    if (script.includes("names.filter((name) => name.endsWith('.meta'))")) {
      return {
        stdout: JSON.stringify({
          runtimeConfig: JSON.stringify({ version: 1, validator: { agent: 'codex', model: 'gpt-5.6-sol' } }),
          journal: JSON.stringify(journal),
          tasks: rawTasks
        }),
        stderr: ''
      }
    }
    if (script.includes('journal.tasks[taskId] = record')) {
      const taskId = args.at(-2) ?? ''
      const record = JSON.parse(Buffer.from(args.at(-1) ?? '', 'base64url').toString('utf8')) as FirstMateLifecycleRecord
      journal = { version: 1, tasks: { ...journal.tasks, [taskId]: record } }
      return { stdout: '', stderr: '' }
    }
    return { stdout: '', stderr: '' }
  }

  const runtime = createFirstMateRuntime({ platform: 'win32', resolveGit: () => 'git.exe', wsl: { run } })
  await runtime.status()

  let deliveryBehavior: () => FirstMateValidationDelivery = () => {
    return { outcome: 'indeterminate', message: 'wsl.exe timed out' }
  }
  const coordinator = createFirstMateLifecycleCoordinator({
    runtime: {
      lifecycle: () => runtime.lifecycle(),
      async continueValidation(taskId: string, dispatchId: string) {
        if (started.has(dispatchId)) {
          return { outcome: 'acknowledged' }
        }
        started.add(dispatchId)
        validationStarts += 1
        return deliveryBehavior()
      },
      recordLifecycle: (taskId, record) => runtime.recordLifecycle(taskId, record)
    },
    wakeCaptain: async () => ({ ok: true })
  })

  // First poll: dispatch with indeterminate outcome
  await coordinator.poll()
  assert.equal(validationStarts, 1, 'validation must start exactly once')

  // Second poll: must not re-dispatch (unresolved claim)
  await coordinator.poll()
  assert.equal(validationStarts, 1, 'an unresolved dispatch must not be re-sent automatically')

  // Release the dispatch and poll again — the SAME identity is resent, deduped by the boundary
  deliveryBehavior = () => ({ outcome: 'acknowledged' })
  assert.deepEqual(await coordinator.releaseDispatch('alpha-ship'), { ok: true })
  await coordinator.poll()

  assert.equal(
    validationStarts,
    1,
    'the boundary deduplicated the resend, so validation started exactly once'
  )
  const lifecycle = await runtime.lifecycle()
  const task = lifecycle.tasks.find((t) => t.id === 'alpha-ship')
  assert.ok(task)
  assert.equal(task.stage, 'validating')
  assert.equal(task.dispatch?.status, 'acknowledged')
})

test('breaking registration, catalog resolution, dispatch pinning, worktree provenance, or validation scoping causes failure', async () => {
  const alphaCrew = createGitCrew('alpha')
  const betaCrew = createGitCrew('beta')
  const { registrations } = await registerProjects({
    projects: [
      { id: 'alpha', name: 'Api', crew: alphaCrew, origin: 'https://github.com/acme/alpha.git' },
      { id: 'beta', name: 'Scratch', crew: betaCrew }
    ]
  })
  const alphaReg = registrations.get('alpha')!
  const betaReg = registrations.get('beta')!
  assert.ok(alphaReg.project)
  assert.ok(betaReg.project)

  const alphaWs = workspaceProject('alpha', 'Api', alphaCrew.primary)
  const betaWs = workspaceProject('beta', 'Scratch', betaCrew.primary)

  const catalog = firstMateProjectCatalog(
    [requestProject(alphaWs, alphaReg), requestProject(betaWs, betaReg)],
    'alpha',
    { provider: 'codex', model: 'gpt-5.6-sol' }
  )

  // 1. Broken registration: inaccessible WSL path refuses registration
  const brokenHost = e2eWslHost({ access: () => ({ accessible: false, message: 'ENOENT: /mnt/d not mounted' }) })
  const brokenRuntime = createFirstMateRuntime({
    platform: 'win32',
    resolveGit: () => 'git.exe',
    inspectCheckout: async () => ({ status: 'git-checkout', origin: 'https://github.com/acme/broken.git' }),
    wsl: { run: brokenHost.run }
  })
  await brokenRuntime.status()
  const brokenReg = await brokenRuntime.registerProject({
    projectId: 'broken', name: 'Broken', path: alphaCrew.primary
  })
  assert.equal(brokenReg.ok, false)

  // 2. Broken catalog resolution: unavailable project has no dispatch context
  const unavailableCatalog = firstMateProjectCatalog(
    [
      requestProject(alphaWs, alphaReg),
      requestProject(betaWs, { ok: false, message: 'WSL unavailable', failure: { kind: 'wsl', adeProjectId: 'beta' } })
    ],
    'alpha',
    { provider: 'codex' }
  )
  assert.deepEqual(unavailableCatalog.projects.map((p) => p.adeProjectId), ['alpha'])
  assert.equal(unavailableCatalog.unavailableProjects[0]?.adeProjectId, 'beta')

  // 3. Broken dispatch pinning: spawn gate refuses when pinned project drifts from authoritative record
  const staleEntry = catalog.projects.find((p) => p.adeProjectId === 'alpha')!
  const staleContext = firstMateTaskContextFromMetadata(staleEntry.taskContextMetadata)!
  const driftedProject: FirstMateSpawnGateProject = {
    ...spawnGateProject(alphaReg.project),
    mode: 'direct-PR'
  }
  const driftProblem = firstMateSpawnContextProblem(staleContext, driftedProject, catalog.validator)
  assert.ok(driftProblem, 'a drifted project posture must refuse the spawn gate')

  const driftedValidator: FirstMateSpawnGateValidator = { agent: 'claude', model: 'claude-sonnet-4-5' }
  const validatorProblem = firstMateSpawnContextProblem(staleContext, spawnGateProject(alphaReg.project), driftedValidator)
  assert.ok(validatorProblem, 'a drifted validator must refuse the spawn gate')

  // 4. Broken worktree provenance: foreign worktree blocks the task
  const foreignCrew = createGitCrew('foreign')
  const alphaTask = fakeCaptainTask(catalog, 'alpha', 'alpha-ship', testWslPath(alphaCrew.worktree), 'ship')
  const foreignProvenance = gitProvenance(foreignCrew.worktree, alphaCrew.primary)
  const foreignLifecycle = firstMateLifecycleFromFiles({
    tasks: [{ ...alphaTask.task, provenance: foreignProvenance }]
  })
  assert.equal(foreignLifecycle.tasks[0]?.stage, 'blocked')

  // 5. Broken validation scoping: a task with no durable ADE context blocks
  const noContextTask: FirstMateRawTask = {
    id: 'orphan',
    meta: [
      'kind=ship', 'mode=no-mistakes', 'yolo=off',
      `project=${alphaReg.project.wslPath}`,
      `worktree=/home/tucaen/.treehouse/alpha/orphan`,
      'harness=codex', 'model=gpt-5.6-sol'
    ].join('\n'),
    status: 'done: committed implementation\n'
  }
  const noContextLifecycle = firstMateLifecycleFromFiles({ tasks: [noContextTask] })
  assert.equal(noContextLifecycle.tasks[0]?.stage, 'blocked')
  assert.match(noContextLifecycle.tasks[0]?.detail ?? '', /no durable ADE task context/i)

  // 6. Metadata drift: spawn metadata project disagrees with pinned context
  const driftedTask = fakeCaptainTask(catalog, 'alpha', 'alpha-drift', testWslPath(alphaCrew.worktree), 'ship')
  const driftedMeta = driftedTask.task.meta.replace(
    new RegExp(`project=${alphaReg.project.wslPath.replace(/\//g, '\\/')}`),
    `project=${betaReg.project.wslPath}`
  )
  const driftedLifecycle = firstMateLifecycleFromFiles({
    tasks: [{ ...driftedTask.task, meta: driftedMeta }]
  })
  assert.equal(driftedLifecycle.tasks[0]?.stage, 'blocked')
  assert.match(driftedLifecycle.tasks[0]?.detail ?? '', /project/)

  // 7. Broken wake delivery: coordinator surfaces failures instead of silently dropping them
  const validTask = fakeCaptainTask(catalog, 'alpha', 'alpha-wake', testWslPath(alphaCrew.worktree), 'ship')
  let wakeJournal: FirstMateLifecycleJournal = { version: 1, tasks: {} }
  const wakeRun = async (args: string[]): Promise<{ stdout: string; stderr: string }> => {
    if (args.includes('-lc')) return { stdout: readyWslInspection(), stderr: '' }
    const scriptIndex = args.indexOf('-e')
    const script = scriptIndex >= 0 ? args[scriptIndex + 1] ?? '' : ''
    if (script.includes("names.filter((name) => name.endsWith('.meta'))")) {
      return {
        stdout: JSON.stringify({
          runtimeConfig: JSON.stringify({ version: 1, validator: catalog.validator }),
          journal: JSON.stringify(wakeJournal),
          tasks: [validTask.task]
        }),
        stderr: ''
      }
    }
    if (script.includes('journal.tasks[taskId] = record')) {
      const taskId = args.at(-2) ?? ''
      const record = JSON.parse(Buffer.from(args.at(-1) ?? '', 'base64url').toString('utf8')) as FirstMateLifecycleRecord
      wakeJournal = { version: 1, tasks: { ...wakeJournal.tasks, [taskId]: record } }
      return { stdout: '', stderr: '' }
    }
    return { stdout: '', stderr: '' }
  }
  const wakeRuntime = createFirstMateRuntime({ platform: 'win32', resolveGit: () => 'git.exe', wsl: { run: wakeRun } })
  await wakeRuntime.status()
  const failedWakes: string[] = []
  const wakeCoordinator = createFirstMateLifecycleCoordinator({
    runtime: wakeRuntime,
    wakeCaptain: async (message) => {
      failedWakes.push(message)
      throw new Error('captain session not ready')
    }
  })
  await wakeCoordinator.poll()
  assert.ok(failedWakes.length > 0, 'a broken wake must still attempt delivery')
})

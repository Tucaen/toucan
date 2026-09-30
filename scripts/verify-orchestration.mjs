/**
 * Live #37 smoke: real Claude orchestrator + ticket sessions, local Git remote, no GitHub writes.
 * Spends account tokens; deliberately outside npm test. Run npm run build:test-out first, then
 * node scripts/verify-orchestration.mjs. Keeps the temporary fixture and evidence for inspection.
 * Permission prompts stop the run for human review; this harness never answers them.
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { testOut } from './test-out.mjs'

const { createAcpSessionManager } = await import(testOut('src/main/acp-session-manager.js'))
const { createAgentEventBroker } = await import(testOut('src/main/agent-event-broker.js'))
const { createOrchestrationStore } = await import(testOut('src/main/orchestration-store.js'))
const { createOrchestratorEndpoint } = await import(testOut('src/main/orchestrator-endpoint.js'))
const { createTicketSpawner } = await import(testOut('src/main/ticket-spawner.js'))
const { createWorktreeManager, runGitWithExecFile } = await import(testOut('src/main/git-worktree.js'))
const { installPushGuard } = await import(testOut('src/main/ticket-push-guard.js'))
const { createOrchestrationCleanup } = await import(testOut('src/main/orchestration-cleanup.js'))
const { createWorkspaceContainment } = await import(testOut('src/main/workspace-containment.js'))
const { createOrchestrationWaker } = await import(testOut('src/main/orchestration-wake.js'))
const { createSessionOutcomeStore } = await import(testOut('src/main/session-outcome-store.js'))
const { createSessionOutcomeIndexer } = await import(testOut('src/main/session-outcome-indexer.js'))

const root = mkdtempSync(join(tmpdir(), 'toucan-orchestration-smoke-'))
const project = join(root, 'project')
const remote = join(root, 'remote.git')
const evidence = []
const log = (message) => {
  evidence.push(message)
  console.log(message)
}
log(`Fixture: ${root}`)
const git = async (args, cwd = project) => {
  const result = await runGitWithExecFile(args, cwd)
  if (result.code !== 0) throw new Error(result.stderr || `git ${args[0]} failed`)
  return result.stdout.trim()
}
await git(['init', '--bare', remote], root)
await git(['init', '-b', 'main', project], root)
await git(['config', 'user.name', 'Toucan smoke'])
await git(['config', 'user.email', 'smoke@example.invalid'])
await git(['remote', 'add', 'origin', remote])
writeFileSync(
  join(project, 'package.json'),
  JSON.stringify({ name: 'orchestration-smoke', private: true, type: 'module', scripts: { test: 'node --test' } })
)
writeFileSync(join(project, 'sum.js'), 'export const sum = (a, b) => a + b\n')
writeFileSync(
  join(project, 'sum.test.js'),
  "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\nimport { sum } from './sum.js'\ntest('sum', () => assert.equal(sum(2, 3), 5))\n"
)
await git(['add', '.'])
await git(['commit', '-m', 'seed smoke fixture'])

const broker = createAgentEventBroker()
const records = createOrchestrationStore({ directory: join(root, 'records') })
const outcomeDirectory = join(root, 'outcomes')
mkdirSync(outcomeDirectory)
const outcomeStore = createSessionOutcomeStore({ directory: outcomeDirectory })
const worktrees = createWorktreeManager()
const outcomes = createSessionOutcomeIndexer({
  broker,
  store: outcomeStore,
  codeStateFor: (cwd) => worktrees.headState(cwd),
  temporaryDirectory: join(root, 'excluded-temp'),
  log
})
const watches = []
const models = new Map()
const efforts = new Map()
let manager
let ticketSpawner
let cleanup
let conversationId
let fatal
process.on('SIGINT', () => {
  fatal = 'Smoke interrupted; retaining fixture for review'
})
let ticketCount = 0
let cleaned = false
const waker = createOrchestrationWaker({
  deliver: (id, text) => {
    log(`Wake: ${text}`)
    return manager.promptWhenIdle(id, text)
  },
  resolve: async () => undefined,
  outcome: async (id) => {
    const found = await outcomeStore.find({ provider: 'claude', conversationId: id })
    return found ? { path: found.path, files: found.record.filesTouched.length } : undefined
  },
  log
})
const endpoint = createOrchestratorEndpoint({
  records,
  routing: {
    config: async () => ({
      ok: true,
      config: {
        tiers: Object.fromEntries(['low', 'medium', 'high', 'frontier'].map((tier) => [tier, { model: 'haiku' }])),
        implementationSkill: 'Implement this ticket directly. Use npm test, inspect your diff and commit.'
      },
      userPath: 'smoke in-memory mapping'
    }),
    offered: () => ({ models: [...models.keys()], efforts: (id) => efforts.get(id) ?? [] }),
    jev: { judge: async () => ({ ok: false, reason: 'smoke deliberately exercises orchestrator fallback' }) }
  },
  spawner: { spawn: (request) => ticketSpawner.spawn(request) },
  cleanup: {
    run: async (record) => {
      const result = await cleanup.run(record)
      log(`Cleanup: ${JSON.stringify(result)}`)
      cleaned = result.removed.length === 2
      return result
    }
  },
  onTicketSpawned: (id, binding) => waker.bind(id, binding),
  ticketSessions: {
    state: (id) => {
      const state = broker.snapshot(id)
      return state && { status: state.status, permission: state.approval, questions: state.decisionRequests }
    },
    startPrompt: (id, text) => manager.startPrompt(id, text),
    promptWhenIdle: (id, text) => manager.promptWhenIdle(id, text),
    answerQuestion: (id, question, content) => manager.resolveElicitation(id, question, content),
    outcome: async (identity) => {
      await Promise.all(watches.map((watch) => watch.idle()))
      return (await outcomeStore.find(identity)) ?? undefined
    }
  },
  log
})
manager = createAcpSessionManager({
  appPath: process.cwd(),
  environment: process.env,
  broker,
  orchestrator: endpoint,
  sessionOutcomes: {
    watch: (...args) => {
      const watch = outcomes.watch(...args)
      watches.push(watch)
      return watch
    }
  },
  sessionOutcomesDirectory: outcomeDirectory,
  onModelsAdvertised: (_provider, entries) => {
    for (const entry of entries) models.set(entry.id, entry)
  },
  onEffortsAdvertised: (_provider, id, entries) => efforts.set(id, entries),
  log
})
const owner = { isDestroyed: () => false, send: () => {} }
broker.observe((id, event) => {
  waker.observe(id, event)
  if (event.type === 'activity') log(`${id}: activity ${event.activity?.title ?? ''}`)
  if (event.type === 'approval') fatal = `Pending permission on ${id}: ${event.title ?? JSON.stringify(event)}`
  if (['turn_complete', 'turn_failed', 'turn_cancelled'].includes(event.type)) log(`${id}: ${event.type}`)
  if (id === 'orchestrator' && event.type === 'turn_failed') fatal = event.message
})
ticketSpawner = createTicketSpawner({
  worktrees,
  runGit: runGitWithExecFile,
  installGuard: (path) => installPushGuard(path, runGitWithExecFile),
  project: async () => ({ id: 'smoke' }),
  runSetup: async () => ({ ok: true }),
  session: (id) => {
    const state = broker.snapshot(id)
    return (
      state && {
        permissionMode: state.modes?.currentModeId,
        model: state.models?.currentModelId,
        effort: state.efforts?.currentEffortId
      }
    )
  },
  offeredModels: () => [...models.keys()],
  onWorktreeCreated: () => {},
  canvas: {
    startTicketSession: async (request) => {
      const id = `ticket-${++ticketCount}`
      const created = await manager.create(
        {
          id,
          provider: 'claude',
          cwd: request.worktree.path,
          modelId: request.modelId,
          effortId: request.effortId,
          permissionMode: request.permissionMode
        },
        owner
      )
      if (!created.ok || created.status !== 'ready') return { ok: false, message: created.message ?? created.status }
      manager.startPrompt(id, request.prompt)
      log(`Spawned ${id}: ${created.sessionId} at ${request.worktree.path}`)
      return { ok: true, nodeId: id, conversationId: created.sessionId }
    }
  }
})
cleanup = createOrchestrationCleanup({
  containment: createWorkspaceContainment({ roots: () => [root] }),
  runGit: runGitWithExecFile,
  worktrees,
  canvas: async ({ session, phase }) => {
    const state = broker.snapshot(session.nodeId)
    if (state && (state.status !== 'ready' || state.approval || state.decisionRequests.length))
      return { ok: false, message: 'session is not settled' }
    if (phase === 'close') manager.kill(session.nodeId)
    return { ok: true }
  }
})

try {
  const created = await manager.create(
    {
      id: 'orchestrator',
      provider: 'claude',
      role: 'orchestrator',
      cwd: project,
      modelId: 'sonnet',
      permissionMode: 'acceptEdits'
    },
    owner
  )
  if (!created.ok || created.status !== 'ready')
    throw new Error(`Orchestrator did not start: ${created.message ?? created.status}`)
  conversationId = created.sessionId
  log(`Orchestrator: ${conversationId}`)
  const accepted = manager.startPrompt(
    'orchestrator',
    `This is a live smoke test in an isolated throwaway repository. Complete two dependent tickets: first add an exported multiply(a,b) to sum.js with a node:test test; second depends on the first and adds README.md documenting sum and multiply. Full test suite: npm test. Use the orchestration workflow, route and spawn both tickets through Toucan, test/rebase/merge/push to the configured LOCAL remote, then cleanup. No tracker exists, so write-back is not applicable. The harness configured a small implementation instruction and an economical tier mapping for this fixture. Do not create external issues or push anywhere except this fixture's origin. Keep plan JSON outside the checkout (use ${root.replace(/\\/g, '/')}). End with the review list.`
  )
  if (!accepted.ok) throw new Error(accepted.message)
  const deadline = Date.now() + 12 * 60_000
  while (Date.now() < deadline && !fatal) {
    if (cleaned && broker.snapshot('orchestrator')?.status === 'ready') break
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  if (fatal) throw new Error(fatal)
  if (!cleaned) throw new Error('Smoke did not complete cleanup before the deadline')
  const record = await records.read({ provider: 'claude', conversationId })
  if (record.tickets.length !== 2 || record.tickets.some((ticket) => ticket.mergeStatus !== 'merged'))
    throw new Error('Tickets were not both merged')
  const head = await git(['rev-parse', 'HEAD'])
  if (head !== (await git(['rev-parse', 'refs/heads/main'], remote)))
    throw new Error('Remote does not hold the merged target')
  if ((await git(['branch', '--list', 'ticket/*'])) !== '') throw new Error('Ticket branches remain')
  log(`PASS: two dependent tickets published at ${head}, cleaned, review follows`)
  log(
    broker
      .snapshot('orchestrator')
      .messages.filter((message) => message.role === 'assistant')
      .at(-1)?.text ?? ''
  )
} catch (error) {
  log(`FAIL: ${error.message}`)
  process.exitCode = 1
} finally {
  manager.killAll()
  await endpoint.close()
  await Promise.all(watches.map((watch) => watch.idle()))
  writeFileSync(join(root, 'evidence.txt'), evidence.join('\n'))
  log(`Evidence retained at ${root}`)
}

import { strict as assert } from 'node:assert'
import { test } from 'vitest'
import { classifyMarkdownLink } from '../src/shared/local-file-link'
import {
  applyPlan,
  applyTicketUpdate,
  clearOrchestrationPacing,
  deferOrchestration,
  FILE_REFERENCE_RULE,
  fileReferenceRule,
  SPAWNS_PER_CHECKPOINT,
  TICKET_CONTRACT_HEADING,
  ticketContract,
  isOrchestrationRecord,
  decisionAnswerFromText,
  orchestratorInstruction,
  parsePlanInput,
  parseEscalateInput,
  parseRouteInput,
  parseSpawnInput,
  parseTicketUpdate,
  recordTicketSession,
  pauseOrchestration,
  resumeOrchestration,
  reserveSpawn,
  continueSpawnBudget,
  spawnBudget,
  spawnBudgetReached,
  startableTickets,
  stopOrchestration,
  ticketBranchCandidates,
  ticketSessionPrompt,
  ticketSessionTitle,
  ticketRunProvider,
  unresolvedAttempt,
  type OrchestrationRecord
} from '../src/shared/orchestration'

// The orchestration record (#33, docs/plans/orchestrator-mode.md): Toucan's tracker-independent
// state for one orchestrator conversation. These are the pure rules the CLI's `plan set` and
// `ticket update` are held to before anything reaches disk.

const identity = { provider: 'claude' as const, conversationId: 'conversation-1', projectPath: 'D:\\project' }
const NOW = '2026-09-30T12:00:00.000Z'
const LATER = '2026-09-30T13:00:00.000Z'

function planned(value: unknown): NonNullable<ReturnType<typeof parsePlanInput>['plan']> {
  const parsed = parsePlanInput(value)
  if (!parsed.plan) throw new Error(`expected a plan, got: ${parsed.error}`)
  return parsed.plan
}

function recordFrom(value: unknown): OrchestrationRecord {
  const applied = applyPlan(undefined, planned(value), identity, NOW)
  if (!applied.record) throw new Error(`expected a record, got: ${applied.error}`)
  return applied.record
}

const twoTickets = {
  task: 'Ship orchestrator mode',
  targetBranch: 'main',
  tickets: [
    { id: '33', title: 'Foundation', body: 'The endpoint and the record' },
    { id: '34', title: 'Spawn', source: 'https://github.com/Tucaen/toucan/issues/34', blockedBy: ['33'] }
  ]
}

test('only a ticket whose blockers have merged can reserve a spawn', () => {
  const record = recordFrom(twoTickets)
  assert.match(reserveSpawn(record, '34', NOW).error ?? '', /unmerged blockers.*33/)
  assert.equal(record.spawnCount ?? 0, 0)
  record.tickets[0].mergeStatus = 'unmerged'
  assert.match(reserveSpawn(record, '34', NOW).error ?? '', /unmerged blockers/)
  record.tickets[0].mergeStatus = 'merged'
  assert.equal(reserveSpawn(record, '34', NOW).record?.spawnCount, 1)
  assert.match(reserveSpawn(record, '33', NOW).error ?? '', /already merged/)
})

test('an answered blocker is settled: its dependents start and it is not spawned again', () => {
  const record = recordFrom(twoTickets)
  record.tickets[0].mergeStatus = 'answered'
  assert.deepEqual(
    startableTickets(record).map((ticket) => ticket.id),
    ['34']
  )
  assert.equal(reserveSpawn(record, '34', NOW).record?.spawnCount, 1)
  assert.match(reserveSpawn(record, '33', NOW).error ?? '', /already answered/)
  assert.deepEqual(parseTicketUpdate({ mergeStatus: 'answered' }).patch, { mergeStatus: 'answered' })
})

test('a plan becomes a record whose tickets start pending with no attempts', () => {
  const record = recordFrom(twoTickets)

  assert.equal(record.version, 1)
  assert.equal(record.provider, 'claude')
  assert.equal(record.conversationId, 'conversation-1')
  assert.equal(record.projectPath, 'D:\\project')
  assert.equal(record.task, 'Ship orchestrator mode')
  assert.equal(record.targetBranch, 'main')
  assert.equal(record.createdAt, NOW)
  assert.deepEqual(record.tickets, [
    {
      id: '33',
      title: 'Foundation',
      body: 'The endpoint and the record',
      blockedBy: [],
      attempts: 0,
      mergeStatus: 'pending'
    },
    {
      id: '34',
      title: 'Spawn',
      source: 'https://github.com/Tucaen/toucan/issues/34',
      blockedBy: ['33'],
      attempts: 0,
      mergeStatus: 'pending'
    }
  ])
  assert.ok(isOrchestrationRecord(record))
})

test('a plan is refused for duplicate ids, unknown or self blockers and dependency cycles', () => {
  const ticket = (id: string, blockedBy: string[] = []) => ({ id, title: `Ticket ${id}`, blockedBy })
  const refusal = (tickets: unknown[]) => parsePlanInput({ task: 't', targetBranch: 'main', tickets }).error

  assert.match(refusal([ticket('1'), ticket('1')]) ?? '', /duplicate ticket id "1"/)
  assert.match(refusal([ticket('1', ['9'])]) ?? '', /unknown ticket "9"/)
  assert.match(refusal([ticket('1', ['1'])]) ?? '', /blocked by itself/)
  assert.match(refusal([ticket('1', ['3']), ticket('2', ['1']), ticket('3', ['2'])]) ?? '', /cycle/)
  assert.match(parsePlanInput({ task: 't', tickets: [] }).error ?? '', /targetBranch/)
  assert.match(parsePlanInput({ task: '', targetBranch: 'main', tickets: [] }).error ?? '', /task/)
  assert.match(refusal([{ id: '1' }]) ?? '', /title/)
  assert.match(parsePlanInput([]).error ?? '', /object/)
})

test('re-planning keeps the progress of tickets that stay and refuses to drop a spawned one', () => {
  const record = recordFrom(twoTickets)
  const progressed: OrchestrationRecord = {
    ...record,
    tickets: record.tickets.map((ticket) =>
      ticket.id === '33' ? { ...ticket, attempts: 1, mergeStatus: 'merged', session: { nodeId: 'node-33' } } : ticket
    )
  }

  const replanned = applyPlan(
    progressed,
    planned({
      ...twoTickets,
      tickets: [
        { id: '33', title: 'Foundation, renamed' },
        { id: '35', title: 'Wake' }
      ]
    }),
    identity,
    LATER
  )
  // 34 was never spawned, so dropping it is the orchestrator's call.
  assert.deepEqual(
    replanned.record?.tickets.map(({ id, title, attempts, mergeStatus, session }) => ({
      id,
      title,
      attempts,
      mergeStatus,
      session
    })),
    [
      { id: '33', title: 'Foundation, renamed', attempts: 1, mergeStatus: 'merged', session: { nodeId: 'node-33' } },
      { id: '35', title: 'Wake', attempts: 0, mergeStatus: 'pending', session: undefined }
    ]
  )
  assert.equal(replanned.record?.createdAt, NOW)
  assert.equal(replanned.record?.updatedAt, LATER)

  const dropped = applyPlan(
    progressed,
    planned({ ...twoTickets, tickets: [{ id: '34', title: 'Spawn' }] }),
    identity,
    LATER
  )
  assert.match(dropped.error ?? '', /ticket "33" has a session/)
})

test('a ticket update changes only the orchestrator-owned fields it names', () => {
  const record = recordFrom(twoTickets)
  const patch = parseTicketUpdate({
    attempts: 2,
    mergeStatus: 'unmerged',
    route: { tier: 'high', model: 'opus', effort: 'max', confidence: 0.4, routedBy: 'orchestrator', escalated: true }
  })
  assert.ok(patch.patch)

  const updated = applyTicketUpdate(record, '34', patch.patch, LATER)
  const ticket = updated.record?.tickets.find((candidate) => candidate.id === '34')
  assert.equal(ticket?.attempts, 2)
  assert.equal(ticket?.mergeStatus, 'unmerged')
  assert.deepEqual(ticket?.route, {
    tier: 'high',
    model: 'opus',
    effort: 'max',
    confidence: 0.4,
    routedBy: 'orchestrator',
    escalated: true
  })
  assert.equal(ticket?.title, 'Spawn')
  assert.equal(updated.record?.updatedAt, LATER)
  // The other ticket is untouched, object for object.
  assert.equal(updated.record?.tickets[0], record.tickets[0])
})

test('a ticket update is refused for unknown tickets, Toucan-owned fields and broken dependencies', () => {
  const record = recordFrom(twoTickets)

  assert.match(parseTicketUpdate({ session: { nodeId: 'x' } }).error ?? '', /"session" is set by Toucan/)
  assert.match(parseTicketUpdate({ id: 'renamed' }).error ?? '', /"id" cannot be updated/)
  assert.match(parseTicketUpdate({ colour: 'red' }).error ?? '', /unknown field "colour"/)
  assert.match(parseTicketUpdate({ attempts: -1 }).error ?? '', /attempts/)
  assert.match(parseTicketUpdate({ mergeStatus: 'done' }).error ?? '', /mergeStatus/)
  assert.match(parseTicketUpdate({ route: { tier: 'extreme' } }).error ?? '', /route.tier/)
  assert.match(parseTicketUpdate({}).error ?? '', /no fields/)

  const unknown = applyTicketUpdate(record, '99', { attempts: 1 }, LATER)
  assert.match(unknown.error ?? '', /no ticket "99"/)
  const cycle = applyTicketUpdate(record, '33', { blockedBy: ['34'] }, LATER)
  assert.match(cycle.error ?? '', /cycle/)
})

test('a record read from disk is validated field by field', () => {
  const record = recordFrom(twoTickets)
  assert.ok(isOrchestrationRecord(JSON.parse(JSON.stringify(record))))
  assert.equal(isOrchestrationRecord({ ...record, version: 2 }), false)
  assert.equal(isOrchestrationRecord({ ...record, tickets: [{ id: '1' }] }), false)
  assert.equal(isOrchestrationRecord({ ...record, provider: 'gemini' }), false)
  assert.equal(isOrchestrationRecord(null), false)
})

test('the orchestrator instruction names the CLI it drives Toucan through', () => {
  const instruction = orchestratorInstruction({
    cliPath: 'C:\\Toucan\\.agents\\skills\\orchestrate\\scripts\\orchestrate.mjs',
    skillPath: 'C:\\Toucan\\.agents\\skills\\orchestrate\\SKILL.md'
  })
  assert.match(instruction, /orchestrator/i)
  assert.ok(instruction.includes('node "C:\\Toucan\\.agents\\skills\\orchestrate\\scripts\\orchestrate.mjs" plan show'))
  assert.ok(instruction.includes('C:\\Toucan\\.agents\\skills\\orchestrate\\SKILL.md'))
})

test('the orchestrator instruction says to end the turn after spawning and wait to be woken (#35)', () => {
  const instruction = orchestratorInstruction({ cliPath: 'cli.mjs', skillPath: 'SKILL.md' })
  assert.match(instruction, /end your turn/i)
  assert.match(instruction, /wakes you/i)
  assert.ok(instruction.includes('node "cli.mjs" status'))
  assert.ok(instruction.includes('node "cli.mjs" followup --ticket <id> --text <text>'))
  assert.match(instruction, /never answers a tool-permission prompt/i)
})

test('the orchestrator instruction merges only through Toucan, never its own Git push', () => {
  const instruction = orchestratorInstruction({ cliPath: 'cli.mjs', skillPath: 'SKILL.md' })
  assert.ok(instruction.includes('node "cli.mjs" merge --ticket <id> --tested <commit>'))
  assert.match(instruction, /never merge into or push the target with your own Git/i)
})

test('the orchestrator instruction keeps implementation and heavy work out of its own turns', () => {
  const instruction = orchestratorInstruction({ cliPath: 'cli.mjs', skillPath: 'SKILL.md' })
  assert.match(instruction, /never implement/i)
  assert.match(instruction, /becomes a ticket/i)
  assert.match(instruction, /test suite/i)
})

test('the orchestrator instruction makes the pre-merge test run a risk-based decision, not a reflex', () => {
  const instruction = orchestratorInstruction({ cliPath: 'cli.mjs', skillPath: 'SKILL.md' })
  assert.match(instruction, /decide from the risk of the change/i)
  assert.match(instruction, /skip the full suite for a change that cannot plausibly break a test/i)
  assert.match(instruction, /CI runs it anyway/i)
  assert.match(instruction, /affected subset only when the risk is real/i)
  assert.match(instruction, /failed run still blocks the merge/i)
  assert.doesNotMatch(instruction, /the pre-merge test run,/i)
})

test('the orchestrator instruction forbids researching the code itself and delegates even a question', () => {
  const instruction = orchestratorInstruction({ cliPath: 'cli.mjs', skillPath: 'SKILL.md' })
  assert.match(instruction, /delegate immediately/i)
  assert.match(instruction, /never research or search the project code yourself/i)
  assert.match(instruction, /a single question included, goes into a ticket session/i)
})

test('orchestrator and ticket sessions are told to link files as absolute file URLs, never bare paths (#3)', () => {
  const instruction = orchestratorInstruction({ cliPath: 'cli.mjs', skillPath: 'SKILL.md' })
  const contract = ticketContract({ path: 'D:\\wt', branch: 'ticket/1' })
  for (const text of [instruction, contract]) {
    assert.ok(text.includes(FILE_REFERENCE_RULE))
  }
  assert.match(FILE_REFERENCE_RULE, /Markdown link/)
  assert.match(FILE_REFERENCE_RULE, /absolute/)
  assert.match(FILE_REFERENCE_RULE, /never as a bare path or a path in backticks/)
})

test('the example link the rule teaches is one both chat surfaces classify as that file', () => {
  const example = /\[[^\]]+\]\(([^)]+)\)/.exec(FILE_REFERENCE_RULE)?.[1]
  assert.equal(example, 'file:///C:/Users/me/shots/before.png')
  assert.deepEqual(classifyMarkdownLink(example), { kind: 'file', path: 'C:\\Users\\me\\shots\\before.png' })
  assert.deepEqual(classifyMarkdownLink('file:///C:/Users/me/My%20Shots/before.png'), {
    kind: 'file',
    path: 'C:\\Users\\me\\My Shots\\before.png'
  })
})

test('with a scratch folder, both prompts say where to save user-facing files and link from there (#3)', () => {
  const scratch = 'D:\\My Project\\.toucan-scratch'
  const instruction = orchestratorInstruction({ cliPath: 'cli.mjs', skillPath: 'SKILL.md', scratchPath: scratch })
  const contract = ticketContract({ path: 'D:\\My Project-ticket-3', branch: 'ticket/3' }, scratch)
  for (const text of [instruction, contract]) {
    assert.ok(text.includes(FILE_REFERENCE_RULE))
    assert.ok(text.includes(`scratch folder ${scratch}`))
    assert.match(text, /not in your worktree and not in the system temp folder/)
    assert.match(text, /a worktree is deleted after the merge/)
    // The example is the real folder, spaces encoded, and the link a session copies opens that file.
    assert.ok(text.includes('[before.png](file:///D:/My%20Project/.toucan-scratch/before.png)'))
  }
  assert.deepEqual(classifyMarkdownLink('file:///D:/My%20Project/.toucan-scratch/before.png'), {
    kind: 'file',
    path: `${scratch}\\before.png`
  })
})

test('without a scratch folder the prompts carry only the base link rule, and nothing names one', () => {
  const instruction = orchestratorInstruction({ cliPath: 'cli.mjs', skillPath: 'SKILL.md' })
  const contract = ticketContract({ path: 'D:\\wt', branch: 'ticket/1' })
  assert.ok(!instruction.includes('.toucan-scratch'))
  assert.ok(!contract.includes('.toucan-scratch'))
  assert.equal(fileReferenceRule(), FILE_REFERENCE_RULE)
})

// Spawning a ticket session (#34): what `spawn` may ask for, the per-orchestration cap, and the
// prompt and title a ticket session is started with.

test('a spawn names a ticket, a model and an effort, and optionally a known provider', () => {
  assert.deepEqual(parseSpawnInput({ ticket: ' 34 ', model: 'claude-opus-5-5', effort: 'high' }).spawn, {
    ticketId: '34',
    model: 'claude-opus-5-5',
    effort: 'high'
  })
  assert.deepEqual(
    parseSpawnInput({ ticket: '34', model: 'm', effort: 'e', provider: 'claude', project: 'D:\\project' }).spawn,
    { ticketId: '34', model: 'm', effort: 'e', provider: 'claude', projectPath: 'D:\\project' }
  )
  assert.match(parseSpawnInput({ model: 'm', effort: 'e' }).error ?? '', /--ticket/)
  assert.match(parseSpawnInput({ ticket: '34', effort: 'e' }).error ?? '', /--model/)
  assert.match(parseSpawnInput({ ticket: '34', model: 'm' }).error ?? '', /--effort/)
  assert.equal(parseSpawnInput({ ticket: '34', model: 'm', effort: 'e', provider: 'codex' }).spawn?.provider, 'codex')
  assert.match(
    parseSpawnInput({ ticket: '34', model: 'm', effort: 'e', provider: 'unknown' }).error ?? '',
    /not supported/
  )
  assert.match(parseSpawnInput(null).error ?? '', /ticket/)
})

test('a spawn may carry --replace, which takes no value (#2)', () => {
  assert.equal(parseSpawnInput({ ticket: '34', replace: true }).spawn?.replace, true)
  assert.equal(parseSpawnInput({ ticket: '34' }).spawn?.replace, undefined)
  assert.match(parseSpawnInput({ ticket: '34', replace: 'yes' }).error ?? '', /--replace takes no value/)
})

test('an attempt is unresolved while starting, working or awaiting review, unless escalated, exited or gone (#2)', () => {
  const base = recordFrom(twoTickets).tickets[0]
  const session = { nodeId: 'n1', branch: 'ticket/33', worktreePath: 'D:\\wt' }
  const route = { tier: 'low' as const, model: 'haiku', effort: 'low', escalated: false }
  const ticket = (extra: Partial<typeof base> = {}, runState?: 'starting') => ({
    ...base,
    session,
    runs: [{ conversationId: 'c1', ...(runState ? { state: runState } : {}), route }],
    route,
    ...extra
  })

  // No session, or a settled ticket: nothing to guard.
  assert.equal(unresolvedAttempt(base, undefined), undefined)
  assert.equal(unresolvedAttempt(ticket({ mergeStatus: 'merged' }), { status: 'ready' }), undefined)
  assert.equal(unresolvedAttempt(ticket({ mergeStatus: 'answered' }), { status: 'working' }), undefined)

  // In flight, or settled and awaiting review: unresolved, and named.
  assert.deepEqual(unresolvedAttempt(ticket({}, 'starting'), undefined), { attempt: 1, ...session, state: 'starting' })
  for (const status of ['starting', 'working', 'auth_required', 'ready']) {
    assert.equal(unresolvedAttempt(ticket(), { status })?.state, status)
  }
  assert.equal(unresolvedAttempt(ticket({ mergeStatus: 'unmerged' }), { status: 'ready' })?.state, 'ready')
  assert.equal(unresolvedAttempt(ticket({ runs: [{}, {}, {}] }), { status: 'working' })?.attempt, 3)

  // Exited, or not running at all (closed, killed, a restart): resolved.
  assert.equal(unresolvedAttempt(ticket(), { status: 'exited' }), undefined)
  assert.equal(unresolvedAttempt(ticket(), undefined), undefined)

  // Escalated since launch: a settled attempt is the orchestrator's failed one; work in flight is not.
  const escalated = { route: { ...route, tier: 'medium' as const, model: 'sonnet', escalated: true } }
  assert.equal(unresolvedAttempt(ticket(escalated), { status: 'ready' }), undefined)
  assert.equal(unresolvedAttempt(ticket(escalated), { status: 'working' })?.state, 'working')
  assert.equal(unresolvedAttempt(ticket(escalated, 'starting'), undefined)?.state, 'starting')
  // An escalated ticket whose latest attempt already launched on the escalated route is unresolved again.
  assert.equal(
    unresolvedAttempt(ticket({ ...escalated, runs: [{ route: escalated.route }] }), { status: 'ready' })?.state,
    'ready'
  )
})

test('a spawn may name a tier instead of a model, or nothing and take the recorded route (#36)', () => {
  assert.deepEqual(parseSpawnInput({ ticket: '34', tier: 'high' }).spawn, { ticketId: '34', tier: 'high' })
  assert.deepEqual(parseSpawnInput({ ticket: '34', tier: 'low', effort: 'medium' }).spawn, {
    ticketId: '34',
    tier: 'low',
    effort: 'medium'
  })
  assert.deepEqual(parseSpawnInput({ ticket: '34' }).spawn, { ticketId: '34' })
  assert.match(parseSpawnInput({ ticket: '34', tier: 'easy' }).error ?? '', /--tier must be one of low, medium/)
  assert.match(parseSpawnInput({ ticket: '34', tier: 'low', model: 'm', effort: 'e' }).error ?? '', /not both/)
})

test('route names nothing, for Jev, or a ticket and the tier the orchestrator judged (#36)', () => {
  assert.deepEqual(parseRouteInput(undefined), { route: {} })
  assert.deepEqual(parseRouteInput({ ticket: ' 12 ', tier: 'medium' }), { route: { ticketId: '12', tier: 'medium' } })
  assert.match(parseRouteInput({ ticket: '12' }).error ?? '', /--tier/)
  assert.match(parseRouteInput({ tier: 'low' }).error ?? '', /--ticket/)
  assert.match(parseRouteInput({ ticket: '12', tier: 'hard' }).error ?? '', /low, medium, high, frontier/)
  assert.deepEqual(parseEscalateInput({ ticket: '12' }), { ticketId: '12' })
  assert.match(parseEscalateInput({}).error ?? '', /escalate needs --ticket/)
})

test('a route carries its depth score and review mark, both checked (#36)', () => {
  assert.deepEqual(parseTicketUpdate({ route: { tier: 'low', depth: 1.5, reviewRequired: true } }).patch, {
    route: { tier: 'low', depth: 1.5, reviewRequired: true }
  })
  assert.match(parseTicketUpdate({ route: { depth: 5 } }).error ?? '', /depth/)
  assert.match(parseTicketUpdate({ route: { reviewRequired: 'yes' } }).error ?? '', /reviewRequired/)
})

test('a ticket session prompt opens with the configured implementation skill', () => {
  const prompt = ticketSessionPrompt({ id: '1', title: 'T', body: 'B' }, { path: 'D:\\w', branch: 'ticket/1' }, '/tdd')
  assert.ok(prompt.startsWith('/tdd #1 T'))
})

test('a spawn is reserved against the record and refused at the budget until the human continues', () => {
  let record = recordFrom(twoTickets)
  assert.match(reserveSpawn(record, '99', NOW).error ?? '', /no ticket "99"/)
  for (let index = 0; index < SPAWNS_PER_CHECKPOINT; index += 1) {
    const reserved = reserveSpawn(record, '33', LATER)
    if (!reserved.record) throw new Error(`spawn ${index + 1} refused: ${reserved.error}`)
    record = reserved.record
  }
  assert.equal(record.spawnCount, SPAWNS_PER_CHECKPOINT)
  assert.equal(record.updatedAt, LATER)
  // Retries and escalations count: the next spawn is refused whichever ticket it is for, and the
  // refusal says it is the budget (machine-readable) rather than a failure.
  const refused = reserveSpawn(record, '33', LATER)
  assert.match(refused.error ?? '', /spawn budget of 20.*Continue/)
  assert.equal(refused.budgetReached, true)
  assert.equal(reserveSpawn(record, '99', LATER).budgetReached, undefined)
  assert.equal(spawnBudgetReached(record), true)
  // Re-planning never resets the count or a raised budget.
  const replanned = applyPlan(record, planned(twoTickets), identity, LATER)
  assert.equal(replanned.record?.spawnCount, SPAWNS_PER_CHECKPOINT)
  const continued = continueSpawnBudget(record, LATER)
  assert.equal(spawnBudget(continued), 2 * SPAWNS_PER_CHECKPOINT)
  const replannedAfterContinue = applyPlan(continued, planned(twoTickets), identity, LATER)
  assert.equal(replannedAfterContinue.record?.spawnBudget, 2 * SPAWNS_PER_CHECKPOINT)
  assert.equal(replannedAfterContinue.record?.spawnCount, SPAWNS_PER_CHECKPOINT)
  assert.equal(reserveSpawn(replannedAfterContinue.record!, '33', LATER).record?.spawnCount, SPAWNS_PER_CHECKPOINT + 1)
  // A record written before spawning existed reads as none used.
  const legacy: Record<string, unknown> = { ...recordFrom(twoTickets) }
  delete legacy.spawnCount
  assert.ok(isOrchestrationRecord(legacy))
  assert.equal(reserveSpawn(legacy as unknown as OrchestrationRecord, '33', NOW).record?.spawnCount, 1)
  assert.equal(isOrchestrationRecord({ ...record, spawnCount: -1 }), false)
  assert.equal(isOrchestrationRecord({ ...record, spawnBudget: 0 }), false)
  assert.equal(isOrchestrationRecord({ ...record, spawnBudget: 40 }), true)
})

test('Continue raises the budget by a checkpoint once, only at the budget, and never revives a stopped record', () => {
  const fresh = recordFrom(twoTickets)
  assert.equal(spawnBudget(fresh), SPAWNS_PER_CHECKPOINT)
  assert.equal(spawnBudgetReached(fresh), false)
  // Below the budget there is nothing to continue: a stale second press cannot stack budgets.
  assert.equal(continueSpawnBudget(fresh, LATER), fresh)

  const atBudget = { ...fresh, spawnCount: SPAWNS_PER_CHECKPOINT }
  const once = continueSpawnBudget(atBudget, LATER)
  assert.equal(once.spawnBudget, 2 * SPAWNS_PER_CHECKPOINT)
  assert.equal(once.spawnCount, SPAWNS_PER_CHECKPOINT)
  assert.equal(once.updatedAt, LATER)
  assert.equal(continueSpawnBudget(once, LATER), once)
  assert.equal(reserveSpawn(once, '33', LATER).error, undefined)

  // The budget is a checkpoint, not a cap: it can be reached and continued again and again.
  const again = continueSpawnBudget({ ...once, spawnCount: 2 * SPAWNS_PER_CHECKPOINT }, LATER)
  assert.equal(spawnBudget(again), 3 * SPAWNS_PER_CHECKPOINT)

  const stopped = stopOrchestration(atBudget, LATER)
  assert.equal(continueSpawnBudget(stopped, LATER), stopped)
})

test('pause, resume and stop are durable orchestration states that gate spawning without changing attempts', () => {
  const original = recordFrom(twoTickets)
  const paused = pauseOrchestration(original, 'node-33', Date.parse(LATER), LATER)

  assert.deepEqual(paused.lifecycle, {
    status: 'paused',
    resetsAt: Date.parse(LATER),
    affectedNodeIds: ['node-33']
  })
  assert.deepEqual(
    paused.tickets.map(({ attempts }) => attempts),
    original.tickets.map(({ attempts }) => attempts)
  )
  assert.match(reserveSpawn(paused, '33', LATER).error ?? '', /paused until/)
  assert.ok(isOrchestrationRecord(JSON.parse(JSON.stringify(paused))))

  const pausedAgain = pauseOrchestration(paused, 'node-34', Date.parse(LATER) + 60_000, LATER)
  assert.deepEqual(pausedAgain.lifecycle, {
    status: 'paused',
    resetsAt: Date.parse(LATER) + 60_000,
    affectedNodeIds: ['node-33', 'node-34']
  })

  const resumed = resumeOrchestration(pausedAgain, LATER)
  assert.equal(resumed.lifecycle, undefined)
  assert.equal(reserveSpawn(resumed, '33', LATER).error, undefined)

  const stopped = stopOrchestration(resumed, LATER)
  assert.deepEqual(stopped.lifecycle, { status: 'stopped' })
  assert.match(reserveSpawn(stopped, '33', LATER).error ?? '', /stopped/)
  assert.equal(resumeOrchestration(stopped, LATER), stopped)
  assert.ok(isOrchestrationRecord(JSON.parse(JSON.stringify(stopped))))
})

test('a proactive pacing deferral is durable, survives replanning and yields to a real provider pause', () => {
  const original = recordFrom(twoTickets)
  const deferred = deferOrchestration(
    original,
    {
      action: 'spawn',
      state: 'pause',
      reason: 'five_hour_pause_threshold',
      constrainingWindow: 'five_hour',
      freshness: 'fresh',
      activeTicketSessions: 1,
      resetsAt: Date.parse(LATER)
    },
    NOW
  )

  assert.deepEqual(deferred.pacing, {
    state: 'pause',
    reason: 'five_hour_pause_threshold',
    constrainingWindow: 'five_hour',
    freshness: 'fresh',
    activeTicketSessions: 1,
    retryAt: Date.parse(LATER),
    deferredAt: NOW
  })
  assert.equal(deferred.spawnCount, undefined)
  assert.ok(isOrchestrationRecord(JSON.parse(JSON.stringify(deferred))))
  assert.deepEqual(applyPlan(deferred, planned(twoTickets), identity, LATER).record?.pacing, deferred.pacing)

  const cleared = clearOrchestrationPacing(deferred, LATER)
  assert.equal(cleared.pacing, undefined)
  assert.equal(clearOrchestrationPacing(cleared, LATER), cleared)

  const reactive = pauseOrchestration(deferred, 'node-33', Date.parse(LATER), LATER)
  assert.equal(reactive.pacing, undefined)
  assert.equal(reactive.lifecycle?.status, 'paused')
})

test('the spawned session is recorded against its ticket', () => {
  const record = recordFrom(twoTickets)
  const session = {
    nodeId: 'node-1',
    conversationId: 'c-1',
    worktreePath: 'D:\\project-ticket-34',
    branch: 'ticket/34'
  }
  const recorded = recordTicketSession(record, '34', session, LATER)
  assert.deepEqual(recorded.tickets.find((ticket) => ticket.id === '34')?.session, session)
  assert.equal(recorded.tickets.find((ticket) => ticket.id === '33')?.session, undefined)
  assert.equal(recorded.updatedAt, LATER)
  assert.ok(isOrchestrationRecord(JSON.parse(JSON.stringify(recorded))))
})

test('every spawned session is kept as a run with the route it launched on (#40)', () => {
  const medium = {
    tier: 'medium' as const,
    model: 'sonnet',
    effort: 'high',
    routedBy: 'jev' as const,
    escalated: false
  }
  const high = { ...medium, tier: 'high' as const, model: 'opus', escalated: true }
  const first = recordTicketSession(recordFrom(twoTickets), '34', { nodeId: 'n-1', conversationId: 'c-1' }, NOW, medium)
  const second = recordTicketSession(first, '34', { nodeId: 'n-2', conversationId: 'c-2' }, LATER, high)
  const ticket = second.tickets.find((candidate) => candidate.id === '34')!
  assert.deepEqual(ticket.session, { nodeId: 'n-2', conversationId: 'c-2' })
  assert.deepEqual(ticket.runs, [
    { conversationId: 'c-1', provider: 'claude', route: medium },
    { conversationId: 'c-2', provider: 'claude', route: high }
  ])
  assert.ok(isOrchestrationRecord(JSON.parse(JSON.stringify(second))))
  assert.equal(isOrchestrationRecord({ ...second, tickets: [{ ...ticket, runs: [{ route: 'x' }] }] }), false)
  assert.equal(isOrchestrationRecord({ ...second, tickets: [{ ...ticket, runs: [{ provider: 'gemini' }] }] }), false)

  // Toucan owns the history: a re-plan keeps it and a ticket update cannot write it.
  const replanned = applyPlan(second, planned(twoTickets), identity, LATER).record!
  assert.deepEqual(replanned.tickets.find((candidate) => candidate.id === '34')?.runs, ticket.runs)
  assert.match(parseTicketUpdate({ runs: [] }).error ?? '', /"runs" is kept by Toucan/)
})

test('a session spawned before runs were kept joins the history, without a launch route, on the next spawn', () => {
  const legacy = recordFrom(twoTickets)
  legacy.tickets[1] = { ...legacy.tickets[1]!, session: { nodeId: 'n-0', conversationId: 'c-0' } }
  const high = { tier: 'high' as const, model: 'opus', routedBy: 'jev' as const, escalated: true }
  const next = recordTicketSession(legacy, '34', { nodeId: 'n-1', conversationId: 'c-1' }, LATER, high)
  assert.deepEqual(next.tickets.find((ticket) => ticket.id === '34')?.runs, [
    { conversationId: 'c-0' },
    { conversationId: 'c-1', provider: 'claude', route: high }
  ])
})

test("a run names its orchestrator's provider; one recorded before the field reads as Claude's (#47)", () => {
  const codex = { ...recordFrom(twoTickets), provider: 'codex' as const }
  const next = recordTicketSession(codex, '34', { nodeId: 'n-1', conversationId: 'c-1' }, LATER)
  const [run] = next.tickets.find((ticket) => ticket.id === '34')?.runs ?? []
  assert.equal(run?.provider, 'codex')
  assert.equal(ticketRunProvider(run), 'codex')
  assert.equal(ticketRunProvider({}), 'claude')
})

test('a ticket branch is a fresh name derived from the ticket id', () => {
  const candidates = ticketBranchCandidates('#34 Spawn!')
  assert.equal(candidates.next().value, 'ticket/34-spawn')
  assert.equal(candidates.next().value, 'ticket/34-spawn-2')
  assert.equal(ticketBranchCandidates('???').next().value, 'ticket/ticket')
})

test('ticket branch names never run out, however many retries a continued budget allows', () => {
  const names: string[] = []
  const candidates = ticketBranchCandidates('34')
  for (let index = 0; index < 3 * SPAWNS_PER_CHECKPOINT + 5; index += 1) names.push(candidates.next().value)
  assert.equal(names.length, 65)
  assert.equal(new Set(names).size, names.length)
  assert.equal(names[0], 'ticket/34')
  assert.equal(names[21], 'ticket/34-22')
  assert.equal(names[64], 'ticket/34-65')
})

test('a ticket session is titled by its ticket and prompted with the skill, the ticket and the contract', () => {
  const [freeText, tracked] = recordFrom(twoTickets).tickets
  assert.equal(ticketSessionTitle(tracked), '#34 Spawn')
  const worktree = { path: 'D:\\project-ticket-34', branch: 'ticket/34' }

  const prompt = ticketSessionPrompt(freeText, worktree)
  assert.ok(prompt.startsWith('/implement #33 Foundation\n\nThe endpoint and the record'))
  // The contract follows the ticket, and wins over the skill.
  const contract = prompt.slice(prompt.indexOf(TICKET_CONTRACT_HEADING))
  assert.ok(prompt.indexOf(TICKET_CONTRACT_HEADING) > prompt.indexOf('The endpoint and the record'))
  assert.ok(contract.includes('D:\\project-ticket-34'))
  assert.ok(contract.includes('ticket/34'))
  assert.match(contract, /never push/i)
  assert.match(contract, /pull request/i)
  assert.match(contract, /merge/i)
  assert.match(contract, /final report/i)
  assert.match(contract, /win over/i)
  // The full suite is the orchestrator's risk-based call, made right before the merge: the session
  // defers it from its final report, runs what it is asked for and names the commit tested; a
  // rebase conflict comes back to it.
  assert.match(contract, /do not run the project's full test suite before your final report/i)
  assert.match(contract, /decides from the risk of the change/i)
  assert.match(contract, /asks, run the full test suite or the tests it names/i)
  assert.match(contract, /rebase this branch onto the target/i)
  assert.match(contract, /commit you tested/i)

  // A tracker reference is handed on for the session to read with its own tools.
  assert.ok(ticketSessionPrompt(tracked, worktree).includes('https://github.com/Tucaen/toucan/issues/34'))
  assert.ok(ticketSessionPrompt(tracked, worktree, '/ship').startsWith('/ship #34 Spawn'))
})

test('a followup answers a question through its free-text slots, and refuses one that has none', () => {
  const base = { options: [{ value: 'a', label: 'A' }], multiSelect: false }
  const request = {
    id: 'q',
    message: 'm',
    questions: [
      { ...base, id: 'pick', question: 'Pick one', input: 'select' as const, customAnswerId: 'pick__other' },
      { ...base, id: 'why', question: 'Why?', options: [], input: 'text' as const },
      { ...base, id: 'flag', question: 'Optional flag', input: 'boolean' as const }
    ]
  }
  assert.deepEqual(decisionAnswerFromText(request, 'Use JSON').content, { pick__other: 'Use JSON', why: 'Use JSON' })
  const fixed = {
    id: 'q',
    message: 'm',
    questions: [{ ...base, id: 'pick', question: 'Pick one', input: 'select' as const, required: true }]
  }
  assert.match(decisionAnswerFromText(fixed, 'Use JSON').error ?? '', /Pick one.*A.*waits for the human/)
})

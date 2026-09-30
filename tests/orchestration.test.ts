import { strict as assert } from 'node:assert'
import { test } from 'vitest'
import {
  applyPlan,
  applyTicketUpdate,
  MAX_SPAWNS_PER_ORCHESTRATION,
  TICKET_CONTRACT_HEADING,
  isOrchestrationRecord,
  decisionAnswerFromText,
  orchestratorInstruction,
  parsePlanInput,
  parseSpawnInput,
  parseTicketUpdate,
  recordTicketSession,
  reserveSpawn,
  ticketBranchCandidates,
  ticketSessionPrompt,
  ticketSessionTitle,
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

// Spawning a ticket session (#34): what `spawn` may ask for, the per-orchestration cap, and the
// prompt and title a ticket session is started with.

test('a spawn names a ticket, a model and an effort, and only ever a Claude session', () => {
  assert.deepEqual(parseSpawnInput({ ticket: ' 34 ', model: 'claude-opus-5-5', effort: 'high' }).spawn, {
    ticketId: '34',
    model: 'claude-opus-5-5',
    effort: 'high'
  })
  assert.deepEqual(
    parseSpawnInput({ ticket: '34', model: 'm', effort: 'e', provider: 'claude', project: 'D:\\project' }).spawn,
    { ticketId: '34', model: 'm', effort: 'e', projectPath: 'D:\\project' }
  )
  assert.match(parseSpawnInput({ model: 'm', effort: 'e' }).error ?? '', /--ticket/)
  assert.match(parseSpawnInput({ ticket: '34', effort: 'e' }).error ?? '', /--model/)
  assert.match(parseSpawnInput({ ticket: '34', model: 'm' }).error ?? '', /--effort/)
  assert.match(parseSpawnInput({ ticket: '34', model: 'm', effort: 'e', provider: 'codex' }).error ?? '', /Claude/)
  assert.match(parseSpawnInput(null).error ?? '', /ticket/)
})

test('a spawn is reserved against the record and refused past twenty per orchestration', () => {
  let record = recordFrom(twoTickets)
  assert.match(reserveSpawn(record, '99', NOW).error ?? '', /no ticket "99"/)
  for (let index = 0; index < MAX_SPAWNS_PER_ORCHESTRATION; index += 1) {
    const reserved = reserveSpawn(record, index % 2 === 0 ? '33' : '34', LATER)
    if (!reserved.record) throw new Error(`spawn ${index + 1} refused: ${reserved.error}`)
    record = reserved.record
  }
  assert.equal(record.spawnCount, MAX_SPAWNS_PER_ORCHESTRATION)
  assert.equal(record.updatedAt, LATER)
  // Retries and escalations count: the twenty-first spawn is refused whichever ticket it is for.
  assert.match(reserveSpawn(record, '33', LATER).error ?? '', /20 spawns/)
  // Re-planning never resets the count.
  const replanned = applyPlan(record, planned(twoTickets), identity, LATER)
  assert.equal(replanned.record?.spawnCount, MAX_SPAWNS_PER_ORCHESTRATION)
  // A record written before spawning existed reads as none used.
  const legacy: Record<string, unknown> = { ...recordFrom(twoTickets) }
  delete legacy.spawnCount
  assert.ok(isOrchestrationRecord(legacy))
  assert.equal(reserveSpawn(legacy as unknown as OrchestrationRecord, '33', NOW).record?.spawnCount, 1)
  assert.equal(isOrchestrationRecord({ ...record, spawnCount: -1 }), false)
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

test('a ticket branch is a fresh name derived from the ticket id', () => {
  const candidates = ticketBranchCandidates('#34 Spawn!')
  assert.equal(candidates[0], 'ticket/34-spawn')
  assert.equal(candidates[1], 'ticket/34-spawn-2')
  assert.equal(new Set(candidates).size, candidates.length)
  assert.equal(ticketBranchCandidates('???')[0], 'ticket/ticket')
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

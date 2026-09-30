import { strict as assert } from 'node:assert'
import { test } from 'vitest'
import {
  applyPlan,
  applyTicketUpdate,
  isOrchestrationRecord,
  orchestratorInstruction,
  parsePlanInput,
  parseTicketUpdate,
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

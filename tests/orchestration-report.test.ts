import { strict as assert } from 'node:assert'
import { test } from 'vitest'
import type { DifficultyTier, OrchestrationRecord, OrchestrationTicket, TicketRoute } from '../src/shared/orchestration'
import {
  proposeMappingChanges,
  routingReport,
  ROUTING_REPORT_MINIMUM_SAMPLE,
  type RoutingReportRow
} from '../src/shared/orchestration-report'
import { DEFAULT_ORCHESTRATION_CONFIG } from '../src/shared/orchestration-routing'

// The routing report (#40): per tier and model, how the project's routed tickets did, and a tier
// mapping change proposed only when enough of them have settled to say so.

const jev = (tier: DifficultyTier, model: string, escalated = false): TicketRoute => ({
  tier,
  model,
  routedBy: 'jev',
  escalated
})

let counter = 0
function ticket(
  mergeStatus: OrchestrationTicket['mergeStatus'],
  ...routes: TicketRoute[]
): OrchestrationTicket & { conversations: string[] } {
  const conversations = routes.map(() => `c-${++counter}`)
  return {
    id: `t-${counter}`,
    title: 'Ticket',
    blockedBy: [],
    attempts: routes.length - 1,
    mergeStatus,
    route: routes.at(-1),
    session: { conversationId: conversations.at(-1) },
    runs: routes.map((route, index) => ({ conversationId: conversations[index], route })),
    conversations
  }
}

function record(tickets: OrchestrationTicket[], conversationId = 'orchestrator-1'): OrchestrationRecord {
  return {
    version: 1,
    provider: 'claude',
    conversationId,
    projectPath: 'D:\\project',
    task: 'Task',
    targetBranch: 'main',
    tickets,
    createdAt: '2026-09-30T12:00:00.000Z',
    updatedAt: '2026-09-30T12:00:00.000Z'
  }
}

const row = (rows: RoutingReportRow[], tier: DifficultyTier, model: string): RoutingReportRow | undefined =>
  rows.find((candidate) => candidate.tier === tier && candidate.model === model)

test('each run counts against the tier and model it ran on; an escalation leaves its failure on the lower tier', () => {
  const merged = ticket('merged', jev('medium', 'sonnet'))
  const escalated = ticket('merged', jev('medium', 'sonnet'), jev('high', 'opus', true))
  const unmerged = ticket('unmerged', jev('medium', 'sonnet'))
  const running = ticket('pending', jev('medium', 'sonnet'))
  const turns = new Map([
    [merged.conversations[0]!, { turns: 2 }],
    [escalated.conversations[0]!, { turns: 6 }],
    [escalated.conversations[1]!, { turns: 3 }],
    [unmerged.conversations[0]!, { turns: 4 }]
  ])
  const report = routingReport([record([merged, escalated, unmerged, running])], turns)

  assert.deepEqual(row(report.jev, 'medium', 'sonnet'), {
    tier: 'medium',
    model: 'sonnet',
    tickets: 4,
    mergedWithoutEscalation: 1,
    mergedAfterEscalation: 0,
    escalated: 1,
    unmerged: 1,
    inProgress: 1,
    medianTurns: 4,
    sample: 3
  })
  // Merging after an escalation is the higher tier's success, but not one "without escalation",
  // and not evidence for a ticket Jev put there.
  assert.deepEqual(row(report.jev, 'high', 'opus'), {
    tier: 'high',
    model: 'opus',
    tickets: 1,
    mergedWithoutEscalation: 0,
    mergedAfterEscalation: 1,
    escalated: 0,
    unmerged: 0,
    inProgress: 0,
    medianTurns: 3,
    sample: 0
  })
  assert.equal(report.orchestrations, 1)
})

test("orchestrator-routed tickets are reported apart and never counted as Jev's", () => {
  const byOrchestrator = ticket('merged', { tier: 'low', model: 'haiku', routedBy: 'orchestrator', escalated: false })
  const byJev = ticket('merged', jev('low', 'haiku'))
  const report = routingReport([record([byOrchestrator, byJev])], new Map())
  assert.equal(row(report.jev, 'low', 'haiku')?.tickets, 1)
  assert.equal(row(report.orchestrator, 'low', 'haiku')?.tickets, 1)
  assert.equal(row(report.jev, 'low', 'haiku')?.medianTurns, null)
})

test('the outcome record route stands in for a run the orchestration record predates, and turns come from it', () => {
  const legacy: OrchestrationTicket = {
    id: 'old',
    title: 'Before runs were kept',
    blockedBy: [],
    attempts: 0,
    mergeStatus: 'merged',
    session: { conversationId: 'legacy' }
  }
  const unrouted: OrchestrationTicket = { ...legacy, id: 'none', session: { conversationId: 'none' } }
  const report = routingReport(
    [record([legacy, unrouted]), record([], 'orchestrator-2')],
    new Map([['legacy', { turns: 5, route: jev('high', 'opus') }]])
  )
  assert.equal(row(report.jev, 'high', 'opus')?.mergedWithoutEscalation, 1)
  assert.equal(row(report.jev, 'high', 'opus')?.medianTurns, 5)
  assert.equal(report.skippedRuns, 1)
  assert.equal(report.orchestrations, 2)
})

test('a stay escalated in counts neither for nor against the tier it was escalated to', () => {
  const twice = ticket('merged', jev('low', 'haiku'), jev('medium', 'sonnet', true), jev('high', 'opus', true))
  const report = routingReport([record([twice])], new Map())
  assert.deepEqual(
    report.jev.map(({ tier, escalated, mergedAfterEscalation, sample }) => [
      tier,
      escalated,
      mergedAfterEscalation,
      sample
    ]),
    [
      ['low', 1, 0, 1],
      ['medium', 1, 0, 0],
      ['high', 0, 1, 0]
    ]
  )
})

test("a run with no launch route takes its outcome record's route over the ticket's escalated one", () => {
  const legacy: OrchestrationTicket = {
    id: 'old',
    title: 'Spawned before runs were kept',
    blockedBy: [],
    attempts: 1,
    mergeStatus: 'merged',
    route: jev('high', 'opus', true),
    session: { conversationId: 'second' },
    runs: [{ conversationId: 'first' }, { conversationId: 'second', route: jev('high', 'opus', true) }]
  }
  const report = routingReport([record([legacy])], new Map([['first', { route: jev('medium', 'sonnet') }]]))
  assert.equal(row(report.jev, 'medium', 'sonnet')?.escalated, 1)
  assert.equal(row(report.jev, 'high', 'opus')?.mergedAfterEscalation, 1)
})

/** `count` settled Jev tickets on one tier and model, `merged` of them merged without escalation. */
function settled(tier: DifficultyTier, model: string, count: number, merged: number): OrchestrationTicket[] {
  return Array.from({ length: count }, (_, index) => ticket(index < merged ? 'merged' : 'unmerged', jev(tier, model)))
}

test('no mapping change is proposed below the minimum sample, however lopsided the numbers', () => {
  const below = ROUTING_REPORT_MINIMUM_SAMPLE - 1
  const rows = routingReport(
    [record([...settled('medium', 'sonnet', below, 0), ...settled('high', 'sonnet', below, below)])],
    new Map()
  ).jev
  assert.deepEqual(proposeMappingChanges(rows, DEFAULT_ORCHESTRATION_CONFIG.tiers), [])
})

test('a tier whose model keeps failing is proposed one tier up, with the numbers behind it', () => {
  const rows = routingReport([record(settled('medium', 'sonnet', 10, 5))], new Map()).jev
  assert.deepEqual(proposeMappingChanges(rows, DEFAULT_ORCHESTRATION_CONFIG.tiers), [
    {
      tier: 'medium',
      from: { model: 'sonnet' },
      to: { model: 'opus' },
      evidence: { model: 'sonnet', mergedWithoutEscalation: 5, sample: 10 },
      summary: 'medium → opus: sonnet merged only 5/10 Jev-routed medium tickets without escalation'
    }
  ])
})

test("a tier a cheaper tier's model handles is proposed down to it", () => {
  const rows = routingReport(
    [record([...settled('high', 'sonnet', 10, 9), ...settled('high', 'opus', 10, 10)])],
    new Map()
  ).jev
  assert.deepEqual(proposeMappingChanges(rows, DEFAULT_ORCHESTRATION_CONFIG.tiers), [
    {
      tier: 'high',
      from: { model: 'opus' },
      to: { model: 'sonnet' },
      evidence: { model: 'sonnet', mergedWithoutEscalation: 9, sample: 10 },
      summary: 'high → sonnet: 9/10 Jev-routed high tickets merged without escalation'
    }
  ])
})

test('orchestrator routes never produce a proposal, and frontier has nowhere higher to go', () => {
  const byOrchestrator = Array.from({ length: 10 }, () =>
    ticket('unmerged', { tier: 'medium', model: 'sonnet', routedBy: 'orchestrator', escalated: false })
  )
  const report = routingReport(
    [record([...byOrchestrator, ...settled('frontier', 'opus', 10, 0)])],
    new Map(),
    DEFAULT_ORCHESTRATION_CONFIG.tiers
  )
  assert.deepEqual(proposeMappingChanges(report.jev, DEFAULT_ORCHESTRATION_CONFIG.tiers), [])
  assert.deepEqual(report.proposals, [])
})

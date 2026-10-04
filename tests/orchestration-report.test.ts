import { strict as assert } from 'node:assert'
import { test } from 'vitest'
import type { AgentProvider } from '../src/shared/agent-provider'
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

function record(
  tickets: OrchestrationTicket[],
  conversationId = 'orchestrator-1',
  provider: AgentProvider = 'claude'
): OrchestrationRecord {
  return {
    version: 1,
    provider,
    conversationId,
    projectPath: 'D:\\project',
    task: 'Task',
    targetBranch: 'main',
    tickets,
    createdAt: '2026-09-30T12:00:00.000Z',
    updatedAt: '2026-09-30T12:00:00.000Z'
  }
}

const row = (
  rows: RoutingReportRow[],
  tier: DifficultyTier,
  model: string,
  provider: AgentProvider = 'claude'
): RoutingReportRow | undefined =>
  rows.find((candidate) => candidate.provider === provider && candidate.tier === tier && candidate.model === model)

test('each run counts against the tier and model it ran on; an escalation leaves its failure on the lower tier', () => {
  const merged = ticket('merged', jev('medium', 'sonnet'))
  const escalated = ticket('merged', jev('medium', 'sonnet'), jev('high', 'opus', true))
  const unmerged = ticket('unmerged', jev('medium', 'sonnet'))
  const running = ticket('pending', jev('medium', 'sonnet'))
  const turns = new Map([
    [`claude-${merged.conversations[0]!}`, { turns: 2 }],
    [`claude-${escalated.conversations[0]!}`, { turns: 6 }],
    [`claude-${escalated.conversations[1]!}`, { turns: 3 }],
    [`claude-${unmerged.conversations[0]!}`, { turns: 4 }]
  ])
  const report = routingReport([record([merged, escalated, unmerged, running])], turns)

  assert.deepEqual(row(report.jev, 'medium', 'sonnet'), {
    provider: 'claude',
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
    provider: 'claude',
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
    new Map([['claude-legacy', { turns: 5, route: jev('high', 'opus') }]])
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
  const report = routingReport([record([legacy])], new Map([['claude-first', { route: jev('medium', 'sonnet') }]]))
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
  assert.deepEqual(proposeMappingChanges(rows, DEFAULT_ORCHESTRATION_CONFIG.tiers, 'claude'), [])
})

test('a tier whose model keeps failing is proposed one tier up, with the numbers behind it', () => {
  const rows = routingReport([record(settled('medium', 'sonnet', 10, 5))], new Map()).jev
  assert.deepEqual(proposeMappingChanges(rows, DEFAULT_ORCHESTRATION_CONFIG.tiers, 'claude'), [
    {
      provider: 'claude',
      configEntry: 'claude.tiers.medium',
      tier: 'medium',
      from: { model: 'sonnet' },
      to: { model: 'opus' },
      evidence: { model: 'sonnet', mergedWithoutEscalation: 5, sample: 10 },
      summary: 'claude.tiers.medium → opus: sonnet merged only 5/10 Jev-routed Claude medium tickets without escalation'
    }
  ])
})

test("a tier a cheaper tier's model handles is proposed down to it", () => {
  const rows = routingReport(
    [record([...settled('high', 'sonnet', 10, 9), ...settled('high', 'opus', 10, 10)])],
    new Map()
  ).jev
  assert.deepEqual(proposeMappingChanges(rows, DEFAULT_ORCHESTRATION_CONFIG.tiers, 'claude'), [
    {
      provider: 'claude',
      configEntry: 'claude.tiers.high',
      tier: 'high',
      from: { model: 'opus' },
      to: { model: 'sonnet' },
      evidence: { model: 'sonnet', mergedWithoutEscalation: 9, sample: 10 },
      summary: 'claude.tiers.high → sonnet: 9/10 Jev-routed Claude high tickets merged without escalation'
    }
  ])
})

test('orchestrator routes never produce a proposal, and frontier has nowhere higher to go', () => {
  const byOrchestrator = Array.from({ length: 10 }, () =>
    ticket('unmerged', { tier: 'medium', model: 'sonnet', routedBy: 'orchestrator', escalated: false })
  )
  const report = routingReport([record([...byOrchestrator, ...settled('frontier', 'opus', 10, 0)])], new Map(), {
    claude: DEFAULT_ORCHESTRATION_CONFIG.tiers
  })
  assert.deepEqual(proposeMappingChanges(report.jev, DEFAULT_ORCHESTRATION_CONFIG.tiers, 'claude'), [])
  assert.deepEqual(report.proposals, [])
})

/** `count` settled Jev tickets run by `provider`'s ticket sessions, as a record written since runs name it. */
function settledOn(
  provider: AgentProvider,
  tier: DifficultyTier,
  model: string,
  count: number,
  merged: number
): OrchestrationTicket[] {
  return settled(tier, model, count, merged).map((ticket) => ({
    ...ticket,
    runs: ticket.runs?.map((run) => ({ ...run, provider }))
  }))
}

const CODEX_TIERS = {
  low: { model: 'gpt-mini' },
  medium: { model: 'sonnet' },
  high: { model: 'gpt-max' },
  frontier: { model: 'gpt-max', effort: 'xhigh' }
}

test('rows name their provider and never combine a same-named model or its outcomes across providers', () => {
  const report = routingReport(
    [
      record(settled('medium', 'sonnet', 2, 2)),
      record(settledOn('codex', 'medium', 'sonnet', 3, 1), 'codex-orchestrator', 'codex')
    ],
    new Map()
  )
  assert.deepEqual(
    report.jev.map(({ provider, tier, model, tickets, mergedWithoutEscalation, unmerged }) => [
      provider,
      tier,
      model,
      tickets,
      mergedWithoutEscalation,
      unmerged
    ]),
    [
      ['claude', 'medium', 'sonnet', 2, 2, 0],
      ['codex', 'medium', 'sonnet', 3, 1, 2]
    ]
  )
})

test('a run with no provider on record is a Claude session, even under a Codex orchestrator', () => {
  const legacy = ticket('merged', jev('medium', 'sonnet'))
  const current = settledOn('codex', 'medium', 'sonnet', 1, 1)
  const turns = new Map([
    [`claude-${legacy.conversations[0]!}`, { turns: 7 }],
    [`codex-${legacy.conversations[0]!}`, { turns: 99 }]
  ])
  const report = routingReport([record([legacy, ...current], 'codex-orchestrator', 'codex')], turns)
  assert.equal(row(report.jev, 'medium', 'sonnet', 'claude')?.tickets, 1)
  assert.equal(row(report.jev, 'medium', 'sonnet', 'claude')?.medianTurns, 7)
  assert.equal(row(report.jev, 'medium', 'sonnet', 'codex')?.tickets, 1)
  assert.equal(row(report.jev, 'medium', 'sonnet', 'codex')?.medianTurns, null)
})

test("each provider's proposals come only from its own runs and name its own configuration entry", () => {
  const report = routingReport(
    [
      // Claude's failing sonnet must not drag Codex's sonnet up, nor Codex's success pull Claude's down.
      record([...settled('medium', 'sonnet', 10, 2), ...settled('high', 'sonnet', 4, 4)]),
      record(
        [...settledOn('codex', 'medium', 'sonnet', 10, 10), ...settledOn('codex', 'high', 'sonnet', 10, 10)],
        'codex-orchestrator',
        'codex'
      )
    ],
    new Map(),
    { claude: DEFAULT_ORCHESTRATION_CONFIG.tiers, codex: CODEX_TIERS }
  )
  assert.deepEqual(
    report.proposals.map(({ provider, configEntry, from, to, evidence }) => ({
      provider,
      configEntry,
      from,
      to,
      evidence
    })),
    [
      {
        provider: 'claude',
        configEntry: 'claude.tiers.medium',
        from: { model: 'sonnet' },
        to: { model: 'opus' },
        evidence: { model: 'sonnet', mergedWithoutEscalation: 2, sample: 10 }
      },
      {
        provider: 'codex',
        configEntry: 'codex.tiers.high',
        from: { model: 'gpt-max' },
        to: { model: 'sonnet' },
        evidence: { model: 'sonnet', mergedWithoutEscalation: 10, sample: 10 }
      }
    ]
  )
})

test('a provider without a usable mapping gets counts but no proposals', () => {
  const report = routingReport(
    [record(settledOn('codex', 'medium', 'sonnet', 10, 0), 'codex-orchestrator', 'codex')],
    new Map(),
    { claude: DEFAULT_ORCHESTRATION_CONFIG.tiers }
  )
  assert.equal(row(report.jev, 'medium', 'sonnet', 'codex')?.sample, 10)
  assert.deepEqual(report.proposals, [])
})

import { strict as assert } from 'node:assert'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'
import { createOrchestrationStore } from '../src/main/orchestration-store'
import {
  createOrchestratorEndpoint,
  type OrchestratorGrant,
  type OrchestratorRouting,
  type TicketSessionControl
} from '../src/main/orchestrator-endpoint'
import {
  applyPlan,
  parsePlanInput,
  recordTicketSession,
  ORCHESTRATOR_TOKEN_ENV,
  ORCHESTRATOR_URL_ENV,
  type OrchestrationRecord,
  type TicketRoute
} from '../src/shared/orchestration'
import { DEFAULT_ORCHESTRATION_CONFIG } from '../src/shared/orchestration-routing'
import type { SessionOutcomeRecord } from '../src/shared/session-outcome'

// `report` on the orchestrator endpoint (#40): the routing report over every orchestration record of
// the orchestrator's own project, with turns read from the ticket sessions' outcome records. The
// aggregation and the sample-size gate are in tests/orchestration-report.test.ts.

const NOW = '2026-09-30T12:00:00.000Z'
const medium: TicketRoute = { tier: 'medium', model: 'sonnet', effort: 'high', routedBy: 'jev', escalated: false }

function finished(conversationId: string, projectPath: string, sessions: string[]): OrchestrationRecord {
  const plan = parsePlanInput({ task: 'Earlier', targetBranch: 'main', tickets: [{ id: '1', title: 'One' }] }).plan!
  let record = applyPlan(undefined, plan, { provider: 'claude', conversationId, projectPath }, NOW).record!
  for (const session of sessions) {
    record = recordTicketSession(record, '1', { nodeId: `n-${session}`, conversationId: session }, NOW, medium)
  }
  return { ...record, tickets: record.tickets.map((ticket) => ({ ...ticket, mergeStatus: 'merged' as const })) }
}

async function call(
  grant: OrchestratorGrant,
  command: string,
  args?: unknown
): Promise<{ status: number; body: Record<string, unknown>; text: string }> {
  const response = await fetch(grant.environment[ORCHESTRATOR_URL_ENV], {
    method: 'POST',
    headers: { Authorization: `Bearer ${grant.environment[ORCHESTRATOR_TOKEN_ENV]}` },
    body: JSON.stringify({ command, args })
  })
  const text = await response.text()
  return { status: response.status, body: JSON.parse(text) as never, text }
}

test("report aggregates the project's orchestrations, with outcome-record turns, and never another project's", async () => {
  const records = createOrchestrationStore({ directory: mkdtempSync(join(tmpdir(), 'toucan-report-')) })
  const put = (record: OrchestrationRecord) =>
    records.update({ provider: 'claude', conversationId: record.conversationId }, () => ({
      value: record,
      result: undefined
    }))
  await put(finished('earlier-1', 'd:/PROJECT', ['s-1']))
  await put(finished('earlier-2', 'D:\\project', ['s-2']))
  await put(finished('elsewhere', 'D:\\other', ['s-3']))
  const turns: Record<string, number> = { 's-1': 2, 's-2': 4, 's-3': 99 }
  const ticketSessions: TicketSessionControl = {
    state: () => undefined,
    startPrompt: () => ({ ok: true }),
    promptWhenIdle: async () => ({ ok: true }),
    answerQuestion: () => ({ ok: true }),
    outcome: async ({ conversationId }) =>
      turns[conversationId] === undefined
        ? undefined
        : { path: `C:\\${conversationId}.md`, record: { turns: turns[conversationId] } as SessionOutcomeRecord }
  }
  let configReads = 0
  const routing: OrchestratorRouting = {
    config: async () => {
      configReads += 1
      return { config: DEFAULT_ORCHESTRATION_CONFIG, userPath: 'C:\\u.json' }
    },
    offered: () => ({ models: [], efforts: () => undefined }),
    jev: { judge: async () => ({ ok: true, judgements: [] }) }
  }
  const endpoint = createOrchestratorEndpoint({ records, routing, ticketSessions, now: () => NOW })
  try {
    const grant = (await endpoint.grant('orchestrator-1', { provider: 'claude', projectPath: 'D:\\project' }))!
    grant.setConversation('current')

    // The current orchestration needs no plan of its own: earlier ones are the evidence.
    const reply = await call(grant, 'report')
    assert.equal(reply.status, 200, reply.text)
    assert.equal(reply.body.orchestrations, 2)
    assert.deepEqual(reply.body.jev, [
      {
        tier: 'medium',
        model: 'sonnet',
        tickets: 2,
        mergedWithoutEscalation: 2,
        mergedAfterEscalation: 0,
        escalated: 0,
        unmerged: 0,
        inProgress: 0,
        medianTurns: 3,
        sample: 2
      }
    ])
    assert.deepEqual(reply.body.orchestrator, [])
    assert.deepEqual(reply.body.proposals, [])
    assert.equal(reply.body.minimumSample, 10)
    assert.deepEqual(reply.body.mapping, DEFAULT_ORCHESTRATION_CONFIG.tiers)
    assert.deepEqual(reply.body.config, { user: 'C:\\u.json', project: null })
    assert.equal(configReads, 1)
    assert.equal((await call(grant, 'report', { apply: true })).status, 400)
  } finally {
    await endpoint.close()
  }
})

test('a broken configuration still gets the counts, with the reason there are no proposals', async () => {
  const records = createOrchestrationStore({ directory: mkdtempSync(join(tmpdir(), 'toucan-report-')) })
  const routing: OrchestratorRouting = {
    config: async () => ({ error: 'tiers.low.model must be a model id', userPath: 'C:\\u.json' }),
    offered: () => ({ models: [], efforts: () => undefined }),
    jev: { judge: async () => ({ ok: true, judgements: [] }) }
  }
  const endpoint = createOrchestratorEndpoint({ records, routing, now: () => NOW })
  try {
    const grant = (await endpoint.grant('orchestrator-1', { provider: 'claude', projectPath: 'D:\\project' }))!
    grant.setConversation('current')
    const reply = await call(grant, 'report')
    assert.equal(reply.status, 200, reply.text)
    assert.deepEqual(reply.body.proposals, [])
    assert.equal(reply.body.mapping, null)
    assert.match(String(reply.body.mappingError), /tiers.low.model/)
  } finally {
    await endpoint.close()
  }
})

test('outcome and report resolve conversations by provider, including ids shared across providers', async () => {
  const records = createOrchestrationStore({ directory: mkdtempSync(join(tmpdir(), 'toucan-provider-report-')) })
  for (const provider of ['claude', 'codex'] as const) {
    const record = { ...finished('captain', 'D:\\project', ['shared-id']), provider }
    await records.update(record, () => ({ value: record, result: undefined }))
  }
  const reads: string[] = []
  const endpoint = createOrchestratorEndpoint({
    records,
    ticketSessions: {
      state: () => undefined,
      startPrompt: () => ({ ok: true }),
      promptWhenIdle: async () => ({ ok: true }),
      answerQuestion: () => ({ ok: true }),
      outcome: async ({ provider, conversationId }) => {
        reads.push(`${provider}:${conversationId}`)
        return { path: `${provider}.md`, record: { turns: provider === 'codex' ? 8 : 2 } as SessionOutcomeRecord }
      }
    }
  })
  try {
    const grant = (await endpoint.grant('captain-node', { provider: 'codex', projectPath: 'D:\\project' }))!
    grant.setConversation('captain')
    const outcome = await call(grant, 'outcome', { ticket: '1' })
    assert.equal(outcome.status, 200)
    assert.equal(outcome.body.path, 'codex.md')
    assert.deepEqual(reads, ['codex:shared-id'])
    reads.length = 0
    const report = await call(grant, 'report')
    assert.equal(report.status, 200)
    assert.deepEqual(reads.sort(), ['claude:shared-id', 'codex:shared-id'])
    assert.equal((report.body.jev as Array<{ medianTurns: number }>)[0].medianTurns, 5)
  } finally {
    await endpoint.close()
  }
})

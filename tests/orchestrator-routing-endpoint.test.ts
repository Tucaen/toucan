import { strict as assert } from 'node:assert'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'
import type { JevRouteResult, JevTicket } from '../src/main/jev-router'
import { createOrchestrationStore } from '../src/main/orchestration-store'
import {
  createOrchestratorEndpoint,
  type OrchestratorGrant,
  type OrchestratorRouting
} from '../src/main/orchestrator-endpoint'
import type { TicketSpawner, TicketSpawnRequest } from '../src/main/ticket-spawner'
import { ORCHESTRATOR_TOKEN_ENV, ORCHESTRATOR_URL_ENV, type TicketRoute } from '../src/shared/orchestration'
import { DEFAULT_ORCHESTRATION_CONFIG, type OrchestrationConfig } from '../src/shared/orchestration-routing'

// Routing on the orchestrator endpoint (#36): `route` asks Jev for every unrouted ticket and resolves
// each tier through the tier mapping, `escalate` moves one tier up, and `spawn` accepts a tier or
// takes the recorded route. Jev and the spawner are faked; the pure rules are in
// tests/orchestration-routing.test.ts.

const plan = {
  task: 'Ship routing',
  targetBranch: 'main',
  tickets: [
    { id: '1', title: 'Rename a flag', body: 'Mechanical.' },
    { id: '2', title: 'Redesign the store', source: '#2' },
    { id: '3', title: 'Already merged' }
  ]
}

const SECRET = 'ts-secret-key-xyz'

function fakeJev(result: JevRouteResult | ((tickets: readonly JevTicket[]) => JevRouteResult)) {
  const calls: JevTicket[][] = []
  return {
    calls,
    judge: async (tickets: readonly JevTicket[]) => {
      calls.push([...tickets])
      return typeof result === 'function' ? result(tickets) : result
    }
  }
}

function fakeSpawner(): TicketSpawner & { calls: TicketSpawnRequest[] } {
  const calls: TicketSpawnRequest[] = []
  return {
    calls,
    async spawn(request) {
      calls.push(request)
      return {
        ok: true,
        session: {
          nodeId: `node-${calls.length}`,
          conversationId: `ticket-${calls.length}`,
          worktreePath: `D:\\w${calls.length}`,
          branch: `ticket/${request.ticket.id}`
        },
        model: request.model,
        effort: request.effort,
        warnings: []
      }
    }
  }
}

interface Options {
  jev?: ReturnType<typeof fakeJev>
  models?: string[]
  efforts?: Record<string, string[]>
  config?: OrchestrationConfig | { error: string }
}

async function harness(options: Options = {}) {
  const records = createOrchestrationStore({ directory: mkdtempSync(join(tmpdir(), 'toucan-routing-')) })
  const spawner = fakeSpawner()
  const jev = options.jev ?? fakeJev({ ok: true, judgements: [] })
  const efforts = options.efforts ?? {
    sonnet: ['low', 'medium', 'high'],
    opus: ['low', 'medium', 'high', 'xhigh', 'max']
  }
  const routing: OrchestratorRouting = {
    config: async () => {
      const config = options.config ?? DEFAULT_ORCHESTRATION_CONFIG
      return 'error' in config
        ? { error: config.error, userPath: 'C:\\u.json' }
        : { config, userPath: 'C:\\u.json', projectPath: 'C:\\p.json' }
    },
    offered: () => ({ models: options.models ?? ['haiku', 'sonnet', 'opus'], efforts: (model) => efforts[model] }),
    jev
  }
  const endpoint = createOrchestratorEndpoint({ records, spawner, routing, now: () => '2026-09-30T12:00:00.000Z' })
  const grant = (await endpoint.grant('orchestrator-1', { provider: 'claude', projectPath: 'D:\\project' }))!
  grant.setConversation('conversation-1')
  const key = { provider: 'claude' as const, conversationId: 'conversation-1' }
  assert.equal((await call(grant, 'plan set', plan)).status, 200)
  assert.equal((await call(grant, 'ticket update', { id: '3', fields: { mergeStatus: 'merged' } })).status, 200)
  const routeOf = async (id: string): Promise<TicketRoute | undefined> =>
    (await records.read(key))?.tickets.find((ticket) => ticket.id === id)?.route
  const runsOf = async (id: string) => (await records.read(key))?.tickets.find((ticket) => ticket.id === id)?.runs
  return { endpoint, grant, spawner, jev, routeOf, runsOf }
}

async function call(
  grant: OrchestratorGrant,
  command: string,
  args?: unknown
): Promise<{ status: number; body: { ok: boolean; error?: string; [key: string]: unknown }; text: string }> {
  const response = await fetch(grant.environment[ORCHESTRATOR_URL_ENV], {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${grant.environment[ORCHESTRATOR_TOKEN_ENV]}`
    },
    body: JSON.stringify({ command, args })
  })
  const text = await response.text()
  return { status: response.status, body: JSON.parse(text) as never, text }
}

const judged: JevRouteResult = {
  ok: true,
  judgements: [
    { ticketId: '1', tier: 'low', confidence: 0.9, depth: 0.3 },
    { ticketId: '2', tier: 'high', confidence: 0.4, depth: 3.2 }
  ]
}

test('route sends every unrouted, unmerged ticket to Jev at once and records each resolved route', async () => {
  const jev = fakeJev(judged)
  const { endpoint, grant, routeOf } = await harness({ jev })
  try {
    const reply = await call(grant, 'route')
    assert.equal(reply.status, 200, reply.text)
    assert.equal(jev.calls.length, 1)
    assert.deepEqual(
      jev.calls[0]!.map((ticket) => ticket.id),
      ['1', '2']
    )
    assert.deepEqual(await routeOf('1'), {
      tier: 'low',
      model: 'haiku',
      effort: 'low',
      confidence: 0.9,
      depth: 0.3,
      routedBy: 'jev',
      escalated: false
    })
    // Low confidence keeps the tier and marks the ticket for review.
    assert.deepEqual(await routeOf('2'), {
      tier: 'high',
      model: 'opus',
      effort: 'xhigh',
      confidence: 0.4,
      depth: 3.2,
      routedBy: 'jev',
      escalated: false,
      reviewRequired: true
    })
    const routes = reply.body.routes as { ticket: string; reviewRequired: boolean }[]
    assert.deepEqual(
      routes.map((route) => [route.ticket, route.reviewRequired]),
      [
        ['1', false],
        ['2', true]
      ]
    )
    assert.deepEqual(reply.body.config, { user: 'C:\\u.json', project: 'C:\\p.json' })

    // Routed tickets are not sent again.
    const again = await call(grant, 'route')
    assert.equal(again.status, 200)
    assert.deepEqual(again.body.routes, [])
    assert.equal(jev.calls.length, 1)
  } finally {
    await endpoint.close()
  }
})

test('a mapped model the picker no longer lists falls back a tier up, and the reply says so', async () => {
  const { endpoint, grant, routeOf } = await harness({ jev: fakeJev(judged), models: ['sonnet', 'opus'] })
  try {
    const reply = await call(grant, 'route')
    assert.equal(reply.status, 200)
    assert.equal((await routeOf('1'))?.model, 'sonnet')
    assert.equal((await routeOf('1'))?.tier, 'low')
    const warnings = reply.body.warnings as string[]
    assert.ok(warnings.some((warning) => /#1: the low tier's model "haiku" is not offered/.test(warning)))
  } finally {
    await endpoint.close()
  }
})

test('Jev unavailable: route says so, and the orchestrator supplies the tier itself', async () => {
  const jev = fakeJev({ ok: false, reason: 'TYPESAFE_API_KEY is not set for Toucan, so Jev cannot be asked' })
  const { endpoint, grant, routeOf } = await harness({ jev })
  try {
    const reply = await call(grant, 'route')
    assert.equal(reply.status, 503)
    assert.equal(reply.body.jevUnavailable, true)
    assert.match(reply.body.error!, /Jev is unavailable: TYPESAFE_API_KEY is not set/)
    assert.match(reply.body.error!, /route --ticket <id> --tier <tier>/)
    assert.equal(await routeOf('1'), undefined)

    const own = await call(grant, 'route', { ticket: '1', tier: 'medium' })
    assert.equal(own.status, 200, own.text)
    assert.deepEqual(await routeOf('1'), {
      tier: 'medium',
      model: 'sonnet',
      effort: 'medium',
      routedBy: 'orchestrator',
      escalated: false
    })
  } finally {
    await endpoint.close()
  }
})

test('the Jev key never reaches a reply', async () => {
  const jev = fakeJev({ ok: false, reason: 'TypeSafe returned HTTP 401: bad key [redacted]' })
  const { endpoint, grant } = await harness({ jev })
  try {
    const reply = await call(grant, 'route')
    assert.ok(!reply.text.includes(SECRET))
  } finally {
    await endpoint.close()
  }
})

test('escalate moves one tier up and refuses past frontier', async () => {
  const { endpoint, grant, routeOf } = await harness({ jev: fakeJev(judged) })
  try {
    await call(grant, 'route')
    const up = await call(grant, 'escalate', { ticket: '2' })
    assert.equal(up.status, 200, up.text)
    assert.deepEqual(await routeOf('2'), {
      tier: 'frontier',
      model: 'opus',
      effort: 'max',
      confidence: 0.4,
      depth: 3.2,
      routedBy: 'jev',
      escalated: true,
      reviewRequired: true
    })
    const past = await call(grant, 'escalate', { ticket: '2' })
    assert.equal(past.status, 409)
    assert.match(past.body.error!, /already at frontier/)
    assert.equal((await call(grant, 'escalate', { ticket: '9' })).status, 400)
  } finally {
    await endpoint.close()
  }
})

test('spawn takes the recorded route, or a tier, and opens the session with the configured skill', async () => {
  const config = { ...DEFAULT_ORCHESTRATION_CONFIG, implementationSkill: '/tdd' }
  const { endpoint, grant, spawner, routeOf } = await harness({ jev: fakeJev(judged), config })
  try {
    await call(grant, 'route')
    const routed = await call(grant, 'spawn', { ticket: '1' })
    assert.equal(routed.status, 200, routed.text)
    assert.equal(spawner.calls[0]!.model, 'haiku')
    assert.equal(spawner.calls[0]!.effort, 'low')
    assert.equal(spawner.calls[0]!.implementationSkill, '/tdd')

    const byTier = await call(grant, 'spawn', { ticket: '2', tier: 'medium' })
    assert.equal(byTier.status, 200, byTier.text)
    assert.equal(spawner.calls[1]!.model, 'sonnet')
    // A tier the orchestrator named over Jev's is its own route.
    assert.equal((await routeOf('2'))?.tier, 'medium')
    assert.equal((await routeOf('2'))?.routedBy, 'orchestrator')
  } finally {
    await endpoint.close()
  }
})

test('each spawn keeps its session and the route it launched on, so an escalation leaves the failed tier behind (#40)', async () => {
  const { endpoint, grant, runsOf } = await harness({ jev: fakeJev(judged) })
  try {
    await call(grant, 'route')
    assert.equal((await call(grant, 'spawn', { ticket: '2' })).status, 200)
    assert.equal((await call(grant, 'escalate', { ticket: '2' })).status, 200)
    assert.equal((await call(grant, 'spawn', { ticket: '2' })).status, 200)
    const runs = await runsOf('2')
    assert.deepEqual(
      runs?.map((run) => [run.conversationId, run.route?.tier, run.route?.model, run.route?.escalated]),
      [
        ['ticket-1', 'high', 'opus', false],
        ['ticket-2', 'frontier', 'opus', true]
      ]
    )
  } finally {
    await endpoint.close()
  }
})

test('spawn without a model, a tier or a recorded route is refused before it counts', async () => {
  const { endpoint, grant, spawner } = await harness()
  try {
    const reply = await call(grant, 'spawn', { ticket: '1' })
    assert.equal(reply.status, 409)
    assert.match(reply.body.error!, /no route yet/)
    assert.equal(spawner.calls.length, 0)
    const shown = await call(grant, 'plan show')
    assert.equal((shown.body.record as { spawnCount?: number }).spawnCount, undefined)
  } finally {
    await endpoint.close()
  }
})

test('a configuration that cannot be read refuses routing and spawning with its reason', async () => {
  const { endpoint, grant, spawner } = await harness({
    jev: fakeJev(judged),
    config: { error: 'the orchestration configuration C:\\u.json is not valid JSON' }
  })
  try {
    const reply = await call(grant, 'route')
    assert.equal(reply.status, 409)
    assert.match(reply.body.error!, /not valid JSON/)
    const spawn = await call(grant, 'spawn', { ticket: '1', model: 'opus', effort: 'high' })
    assert.equal(spawn.status, 409)
    assert.equal(spawner.calls.length, 0)
  } finally {
    await endpoint.close()
  }
})

test('status shows each ticket route', async () => {
  const { endpoint, grant } = await harness({ jev: fakeJev(judged) })
  try {
    await call(grant, 'route')
    const reply = await call(grant, 'status')
    const tickets = reply.body.tickets as { id: string; route: TicketRoute | null }[]
    assert.equal(tickets.find((ticket) => ticket.id === '1')?.route?.model, 'haiku')
    assert.equal(tickets.find((ticket) => ticket.id === '3')?.route, null)
  } finally {
    await endpoint.close()
  }
})

test('spawn --model records the orchestrator route without Jev confidence', async () => {
  const { endpoint, grant, routeOf } = await harness({ jev: fakeJev(judged) })
  try {
    await call(grant, 'route')
    const reply = await call(grant, 'spawn', { ticket: '2', model: 'sonnet', effort: 'high' })
    assert.equal(reply.status, 200, reply.text)
    assert.deepEqual(await routeOf('2'), {
      tier: 'high',
      model: 'sonnet',
      effort: 'high',
      routedBy: 'orchestrator',
      escalated: false
    })
  } finally {
    await endpoint.close()
  }
})

test('a recorded model the picker dropped since route is resolved again at spawn', async () => {
  const models = ['haiku', 'sonnet', 'opus']
  const { endpoint, grant, spawner } = await harness({ jev: fakeJev(judged), models })
  try {
    await call(grant, 'route')
    models.splice(0, 1)
    const reply = await call(grant, 'spawn', { ticket: '1' })
    assert.equal(reply.status, 200, reply.text)
    assert.equal(spawner.calls[0]!.model, 'sonnet')
    assert.ok((reply.body.warnings as string[]).some((warning) => /"haiku" is not offered/.test(warning)))
  } finally {
    await endpoint.close()
  }
})

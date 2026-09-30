import { strict as assert } from 'node:assert'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'
import { createOrchestrationStore } from '../src/main/orchestration-store'
import { createOrchestratorEndpoint, type OrchestratorGrant } from '../src/main/orchestrator-endpoint'
import type { TicketSpawner, TicketSpawnRequest } from '../src/main/ticket-spawner'
import {
  MAX_SPAWNS_PER_ORCHESTRATION,
  ORCHESTRATOR_TOKEN_ENV,
  ORCHESTRATOR_URL_ENV,
  pauseOrchestration,
  stopOrchestration
} from '../src/shared/orchestration'

// `spawn` on the orchestrator endpoint (#34): who may spawn, what is refused before anything is
// created, and that the session lands on its ticket in the record. The spawner itself - worktree,
// hook, setup command, canvas - is faked here and covered in tests/ticket-spawner.test.ts.

const plan = {
  task: 'Ship orchestrator mode',
  targetBranch: 'main',
  tickets: [
    { id: '33', title: 'Foundation', body: 'The endpoint and the record' },
    { id: '34', title: 'Spawn', blockedBy: ['33'] }
  ]
}

function fakeSpawner(outcome: 'ok' | 'fail' = 'ok'): TicketSpawner & { calls: TicketSpawnRequest[] } {
  const calls: TicketSpawnRequest[] = []
  return {
    calls,
    async spawn(request) {
      calls.push(request)
      if (outcome === 'fail') return { ok: false, error: 'git worktree add failed' }
      return {
        ok: true,
        session: {
          nodeId: `node-${calls.length}`,
          conversationId: `ticket-conversation-${calls.length}`,
          worktreePath: `D:\\project-ticket-${request.ticket.id}`,
          branch: `ticket/${request.ticket.id}`
        },
        model: request.model,
        effort: request.effort,
        warnings: []
      }
    }
  }
}

function harness(spawner?: TicketSpawner) {
  const directory = mkdtempSync(join(tmpdir(), 'toucan-orchestrator-spawn-'))
  const records = createOrchestrationStore({ directory })
  const endpoint = createOrchestratorEndpoint({ records, spawner, now: () => '2026-09-30T12:00:00.000Z' })
  return { records, endpoint }
}

async function call(
  grant: OrchestratorGrant,
  command: string,
  args?: unknown,
  token: string | null = grant.environment[ORCHESTRATOR_TOKEN_ENV]
): Promise<{ status: number; body: { ok: boolean; error?: string; [key: string]: unknown } }> {
  const response = await fetch(grant.environment[ORCHESTRATOR_URL_ENV], {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token === null ? {} : { Authorization: `Bearer ${token}` }) },
    body: JSON.stringify({ command, args })
  })
  return { status: response.status, body: (await response.json()) as never }
}

async function planned(spawner?: TicketSpawner) {
  const { records, endpoint } = harness(spawner)
  const grant = (await endpoint.grant('orchestrator-1', { provider: 'claude', projectPath: 'D:\\project' }))!
  grant.setConversation('conversation-1')
  assert.equal((await call(grant, 'plan set', plan)).status, 200)
  return { records, endpoint, grant }
}

const spawn34 = { ticket: '34', model: 'claude-opus-5-5', effort: 'high' }

test('a spawn hands the spawner the ticket, the target branch and the orchestrator, and records the session', async () => {
  const spawner = fakeSpawner()
  const { records, endpoint, grant } = await planned(spawner)
  try {
    const reply = await call(grant, 'spawn', spawn34)
    assert.equal(reply.status, 200)
    assert.equal(spawner.calls.length, 1)
    const [request] = spawner.calls
    assert.equal(request.projectPath, 'D:\\project')
    assert.equal(request.targetBranch, 'main')
    assert.deepEqual(request.orchestrator, { nodeId: 'orchestrator-1', conversationId: 'conversation-1' })
    assert.equal(request.ticket.id, '34')
    assert.equal(request.model, 'claude-opus-5-5')
    assert.equal(request.effort, 'high')
    assert.equal(reply.body.spawnsLeft, MAX_SPAWNS_PER_ORCHESTRATION - 1)

    const record = await records.read({ provider: 'claude', conversationId: 'conversation-1' })
    assert.deepEqual(record?.tickets.find((ticket) => ticket.id === '34')?.session, {
      nodeId: 'node-1',
      conversationId: 'ticket-conversation-1',
      worktreePath: 'D:\\project-ticket-34',
      branch: 'ticket/34'
    })
    assert.equal(record?.spawnCount, 1)
  } finally {
    await endpoint.close()
  }
})

test('paused and stopped orchestrations refuse a spawn before the spawner is called', async () => {
  const spawner = fakeSpawner()
  const { records, endpoint, grant } = await planned(spawner)
  const key = { provider: 'claude' as const, conversationId: 'conversation-1' }
  try {
    await records.update(key, (current) => ({
      value: current && pauseOrchestration(current, 'node-34', Date.parse('2026-09-30T15:00:00Z'), current.updatedAt),
      result: undefined
    }))
    const paused = await call(grant, 'spawn', spawn34)
    assert.equal(paused.status, 429)
    assert.match(paused.body.error ?? '', /paused until/)
    assert.equal(spawner.calls.length, 0)

    await records.update(key, (current) => ({
      value: current && stopOrchestration(current, current.updatedAt),
      result: undefined
    }))
    const stopped = await call(grant, 'spawn', spawn34)
    assert.equal(stopped.status, 429)
    assert.match(stopped.body.error ?? '', /stopped/)
    assert.equal(spawner.calls.length, 0)
  } finally {
    await endpoint.close()
  }
})

test('a spawn without an orchestrator token is refused: ticket sessions cannot nest', async () => {
  const spawner = fakeSpawner()
  const { endpoint, grant } = await planned(spawner)
  try {
    // A ticket session carries no token at all; a stale or guessed one is no better.
    assert.equal((await call(grant, 'spawn', spawn34, null)).status, 401)
    assert.equal((await call(grant, 'spawn', spawn34, 'a-ticket-session-guess')).status, 401)
    // Another grant keeps the listener up, so this is the revoked token being refused.
    const other = (await endpoint.grant('orchestrator-2', { provider: 'claude', projectPath: 'D:\\project' }))!
    grant.revoke()
    assert.equal((await call(grant, 'spawn', spawn34)).status, 401)
    other.revoke()
    assert.equal(spawner.calls.length, 0)
  } finally {
    await endpoint.close()
  }
})

test('a spawn into another project is refused, by flag and by record', async () => {
  const spawner = fakeSpawner()
  const { endpoint, grant } = await planned(spawner)
  try {
    const flagged = await call(grant, 'spawn', { ...spawn34, project: 'D:\\other' })
    assert.equal(flagged.status, 403)
    assert.match(flagged.body.error ?? '', /another project/)
    // The same checkout spelled differently is the same project.
    assert.equal((await call(grant, 'spawn', { ...spawn34, project: 'd:/project/' })).status, 200)

    const elsewhere = (await endpoint.grant('orchestrator-2', { provider: 'claude', projectPath: 'D:\\other' }))!
    elsewhere.setConversation('conversation-1')
    const scoped = await call(elsewhere, 'spawn', spawn34)
    assert.equal(scoped.status, 403)
    assert.match(scoped.body.error ?? '', /another project/)
    assert.equal(spawner.calls.length, 1)
  } finally {
    await endpoint.close()
  }
})

test('a spawn for a provider other than Claude is refused', async () => {
  const spawner = fakeSpawner()
  const { endpoint, grant } = await planned(spawner)
  try {
    const reply = await call(grant, 'spawn', { ...spawn34, provider: 'codex' })
    assert.equal(reply.status, 400)
    assert.match(reply.body.error ?? '', /Claude/)
    assert.equal(spawner.calls.length, 0)
  } finally {
    await endpoint.close()
  }
})

test('the twenty-first spawn of an orchestration is refused, failed spawns and retries included', async () => {
  const failing = fakeSpawner('fail')
  const { records, endpoint, grant } = await planned(failing)
  try {
    const failed = await call(grant, 'spawn', spawn34)
    assert.equal(failed.status, 502)
    assert.match(failed.body.error ?? '', /git worktree add failed/)
    // A retry of the same ticket counts like any other spawn.
    for (let index = 1; index < MAX_SPAWNS_PER_ORCHESTRATION; index += 1) {
      assert.equal((await call(grant, 'spawn', index % 2 ? spawn34 : { ...spawn34, ticket: '33' })).status, 502)
    }
    const refused = await call(grant, 'spawn', spawn34)
    assert.equal(refused.status, 429)
    assert.match(refused.body.error ?? '', /20 spawns/)
    assert.equal(failing.calls.length, MAX_SPAWNS_PER_ORCHESTRATION)
    // A failed spawn records no session.
    const record = await records.read({ provider: 'claude', conversationId: 'conversation-1' })
    assert.equal(record?.tickets.find((ticket) => ticket.id === '34')?.session, undefined)
  } finally {
    await endpoint.close()
  }
})

test('there is no concurrency cap: spawns in flight together all run', async () => {
  const spawner = fakeSpawner()
  const { records, endpoint, grant } = await planned(spawner)
  try {
    const replies = await Promise.all([
      call(grant, 'spawn', spawn34),
      call(grant, 'spawn', { ...spawn34, ticket: '33' })
    ])
    assert.deepEqual(
      replies.map((reply) => reply.status),
      [200, 200]
    )
    const record = await records.read({ provider: 'claude', conversationId: 'conversation-1' })
    assert.equal(record?.spawnCount, 2)
    assert.ok(record?.tickets.every((ticket) => ticket.session?.nodeId))
  } finally {
    await endpoint.close()
  }
})

test('a spawn is refused for an unknown ticket, before a plan, and when no spawner is wired', async () => {
  const spawner = fakeSpawner()
  const { endpoint, grant } = await planned(spawner)
  try {
    const unknown = await call(grant, 'spawn', { ...spawn34, ticket: '99' })
    assert.equal(unknown.status, 400)
    assert.match(unknown.body.error ?? '', /no ticket "99"/)
    // With neither a model nor a tier the recorded route decides (#36), and without routing there is none.
    assert.equal((await call(grant, 'spawn', { ticket: '34' })).status, 501)
    assert.equal((await call(grant, 'spawn', { ticket: '34', effort: 'high' })).status, 400)
  } finally {
    await endpoint.close()
  }

  const bare = harness(spawner)
  const early = (await bare.endpoint.grant('orchestrator-1', { provider: 'claude', projectPath: 'D:\\project' }))!
  early.setConversation('conversation-2')
  try {
    const noPlan = await call(early, 'spawn', spawn34)
    assert.equal(noPlan.status, 404)
    assert.match(noPlan.body.error ?? '', /plan set first/)
  } finally {
    await bare.endpoint.close()
  }

  const unwired = harness()
  const lone = (await unwired.endpoint.grant('orchestrator-1', { provider: 'claude', projectPath: 'D:\\project' }))!
  lone.setConversation('conversation-3')
  try {
    assert.equal((await call(lone, 'plan set', plan)).status, 200)
    assert.equal((await call(lone, 'spawn', spawn34)).status, 501)
  } finally {
    await unwired.endpoint.close()
  }
  assert.equal(spawner.calls.length, 0)
})

import { strict as assert } from 'node:assert'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'
import type { DiscardTarget } from '../src/main/orchestration-cleanup'
import { createOrchestrationStore } from '../src/main/orchestration-store'
import {
  createOrchestratorEndpoint,
  type OrchestratorGrant,
  type TicketSessionControl
} from '../src/main/orchestrator-endpoint'
import type { TicketSpawner } from '../src/main/ticket-spawner'
import type { UnrecordedAttempt } from '../src/shared/orchestration-cleanup'
import {
  ORCHESTRATOR_TOKEN_ENV,
  ORCHESTRATOR_URL_ENV,
  parseDiscardInput,
  parseSpawnInput,
  type OrchestrationRecord
} from '../src/shared/orchestration'

// `spawn --adopt` links an unrecorded worktree to a ticket; `discard` throws an attempt away (#4).

const plan = { task: 'Adopt and discard', targetBranch: 'main', tickets: [{ id: '4', title: 'Adopt' }] }

const spawner: TicketSpawner = {
  async spawn(request) {
    return {
      ok: true,
      session: {
        nodeId: `node-${request.ticket.id}`,
        conversationId: `conversation-${request.ticket.id}`,
        worktreePath: `D:\\project-${request.ticket.id}`,
        branch: `ticket/${request.ticket.id}`
      },
      warnings: []
    }
  }
}

async function call(grant: OrchestratorGrant, command: string, args?: unknown) {
  const response = await fetch(grant.environment[ORCHESTRATOR_URL_ENV], {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${grant.environment[ORCHESTRATOR_TOKEN_ENV]}`
    },
    body: JSON.stringify({ command, args })
  })
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown> & { ok: boolean; error?: string }
  }
}

async function world(orphans: UnrecordedAttempt[] = [], states: Record<string, { status: string }> = {}) {
  const stopped: Array<{ nodeId: string; starting: boolean }> = []
  const discarded: DiscardTarget[] = []
  const bound: string[] = []
  const live = { ...states }
  const sessions: TicketSessionControl = {
    state: (nodeId) => (live[nodeId] ? ({ ...live[nodeId], questions: [] } as never) : undefined),
    startPrompt: () => ({ ok: true }),
    promptWhenIdle: async () => ({ ok: true }),
    answerQuestion: () => ({ ok: true }),
    stop: (nodeId, options) => {
      stopped.push({ nodeId, starting: options.starting })
      delete live[nodeId]
    },
    outcome: async () => undefined
  }
  const records = createOrchestrationStore({ directory: mkdtempSync(join(tmpdir(), 'toucan-adopt-discard-')) })
  const endpoint = createOrchestratorEndpoint({
    records,
    spawner,
    ticketSessions: sessions,
    onTicketSpawned: (nodeId) => bound.push(nodeId),
    cleanup: {
      run: async () => ({ removed: [], retained: [] }),
      answeredRefusal: async () => undefined,
      unrecorded: async () => orphans,
      discard: async (_record, target) => {
        discarded.push(target)
        return { ok: true, removedWorktree: target.worktreePath !== undefined, deletedBranch: true, ahead: 2 }
      }
    }
  })
  const grant = (await endpoint.grant('orchestrator-node', { provider: 'claude', projectPath: 'D:\\project' }))!
  grant.setConversation('orchestrator-conversation')
  assert.equal((await call(grant, 'plan set', plan)).status, 200)
  const read = async (): Promise<OrchestrationRecord> =>
    (await records.read({ provider: 'claude', conversationId: 'orchestrator-conversation' }))!
  return { endpoint, grant, stopped, discarded, bound, live, read }
}

const orphan: UnrecordedAttempt = {
  ticket: '4',
  path: 'D:\\project-orphan',
  branch: 'ticket/4',
  ahead: 3,
  liveSession: true,
  nodeId: 'orphan-node',
  conversationId: 'orphan-conversation'
}

test('adopt links an unrecorded worktree and its live session as the ticket attempt', async () => {
  const w = await world([orphan], { 'orphan-node': { status: 'ready' } })
  try {
    const reply = await call(w.grant, 'spawn', { ticket: '4', adopt: 'D:\\project-orphan' })
    assert.equal(reply.status, 200, String(reply.body.error))
    assert.equal(reply.body.adopted, true)
    assert.equal(reply.body.attempt, 1)
    const ticket = (await w.read()).tickets[0]
    const where = {
      nodeId: 'orphan-node',
      conversationId: 'orphan-conversation',
      worktreePath: 'D:\\project-orphan',
      branch: 'ticket/4'
    }
    assert.deepEqual(ticket.session, where)
    assert.deepEqual(
      ticket.runs?.map(({ nodeId, conversationId, worktreePath, branch }) => ({
        nodeId,
        conversationId,
        worktreePath,
        branch
      })),
      [where]
    )
    assert.deepEqual(w.bound, ['orphan-node'])
    // Adoption creates nothing, so it costs no spawn.
    assert.equal((await w.read()).spawnCount ?? 0, 0)
    // The live session now holds the ticket: a plain spawn is a duplicate.
    const duplicate = await call(w.grant, 'spawn', { ticket: '4', model: 'm', effort: 'high' })
    assert.equal(duplicate.status, 409)
    assert.equal(duplicate.body.duplicate, true)
  } finally {
    await w.endpoint.close()
  }
})

test('adopt respects the duplicate guard and refuses a worktree that is not unrecorded or is another ticket’s', async () => {
  const w = await world([orphan, { ...orphan, ticket: '9', path: 'D:\\project-9', branch: 'ticket/9' }])
  try {
    assert.equal((await call(w.grant, 'spawn', { ticket: '4', adopt: 'D:\\elsewhere' })).status, 404)
    const other = await call(w.grant, 'spawn', { ticket: '4', adopt: 'D:\\project-9' })
    assert.equal(other.status, 409)
    assert.match(String(other.body.error), /belongs to ticket 9/)

    assert.equal((await call(w.grant, 'spawn', { ticket: '4', model: 'm', effort: 'high' })).status, 200)
    w.live['node-4'] = { status: 'working' }
    const refused = await call(w.grant, 'spawn', { ticket: '4', adopt: 'D:\\project-orphan' })
    assert.equal(refused.status, 409)
    assert.equal(refused.body.duplicate, true)
  } finally {
    await w.endpoint.close()
  }
})

test('spawn records where each attempt ran, and discard --attempt stops it, removes it and records it discarded', async () => {
  const w = await world([], { 'node-4': { status: 'working' } })
  try {
    assert.equal((await call(w.grant, 'spawn', { ticket: '4', model: 'm', effort: 'high' })).status, 200)
    const run = (await w.read()).tickets[0].runs![0]
    assert.equal(run.worktreePath, 'D:\\project-4')
    assert.equal(run.branch, 'ticket/4')
    assert.equal(run.nodeId, 'node-4')

    assert.equal((await call(w.grant, 'discard', { ticket: '4', attempt: 2 })).status, 404)
    const reply = await call(w.grant, 'discard', { ticket: '4', attempt: 1 })
    assert.equal(reply.status, 200, String(reply.body.error))
    assert.equal(reply.body.deletedBranch, true)
    assert.deepEqual(w.stopped, [{ nodeId: 'node-4', starting: false }])
    assert.equal(w.discarded[0].branch, 'ticket/4')
    assert.equal(w.discarded[0].worktreePath, 'D:\\project-4')

    const ticket = (await w.read()).tickets[0]
    assert.equal(ticket.runs![0].discarded, true)
    assert.equal(ticket.session, undefined)
    assert.equal((await call(w.grant, 'discard', { ticket: '4', attempt: 1 })).status, 409)
    // The ticket is free again: a plain spawn is no duplicate.
    assert.equal((await call(w.grant, 'spawn', { ticket: '4', model: 'm', effort: 'high' })).status, 200)
    assert.equal((await w.read()).tickets[0].runs!.length, 2)
  } finally {
    await w.endpoint.close()
  }
})

test('discard --branch throws away an unrecorded attempt, and refuses a branch the record holds', async () => {
  const w = await world([orphan], { 'orphan-node': { status: 'ready' } })
  try {
    const refused = await call(w.grant, 'discard', { branch: 'ticket/unknown' })
    assert.equal(refused.status, 404)
    const reply = await call(w.grant, 'discard', { branch: 'ticket/4' })
    assert.equal(reply.status, 200, String(reply.body.error))
    assert.deepEqual(w.stopped, [{ nodeId: 'orphan-node', starting: false }])
    assert.equal(w.discarded[0].worktreePath, 'D:\\project-orphan')
    assert.equal(reply.body.discardedCommits, 2)
  } finally {
    await w.endpoint.close()
  }
})

test('discard and adopt parse their flags', () => {
  assert.deepEqual(parseDiscardInput({ ticket: '4', attempt: '2' }), { discard: { ticketId: '4', attempt: 2 } })
  assert.deepEqual(parseDiscardInput({ branch: 'ticket/4' }), { discard: { branch: 'ticket/4' } })
  for (const bad of [
    {},
    { ticket: '4' },
    { ticket: '4', attempt: 0 },
    { branch: 'main' },
    { branch: 'ticket/4', ticket: '4' }
  ]) {
    assert.ok(parseDiscardInput(bad).error !== undefined, JSON.stringify(bad))
  }
  assert.deepEqual(parseSpawnInput({ ticket: '4', adopt: 'D:\\wt' }), { spawn: { ticketId: '4', adopt: 'D:\\wt' } })
  assert.ok(parseSpawnInput({ ticket: '4', adopt: 'D:\\wt', tier: 'low' }).error !== undefined)
  assert.ok(parseSpawnInput({ ticket: '4', adopt: true }).error !== undefined)
})

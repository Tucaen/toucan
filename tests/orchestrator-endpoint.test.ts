import { strict as assert } from 'node:assert'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'
import { createOrchestrationStore } from '../src/main/orchestration-store'
import { createOrchestratorEndpoint, type OrchestratorGrant } from '../src/main/orchestrator-endpoint'
import { createProviderUsage } from '../src/main/provider-usage'
import { ORCHESTRATOR_TOKEN_ENV, ORCHESTRATOR_URL_ENV } from '../src/shared/orchestration'

// The orchestrator's local endpoint (#33): every call is authorized at call time against a live
// token and scoped to that orchestrator's project. Driven over real HTTP, the way the CLI calls it.

function harness() {
  const directory = mkdtempSync(join(tmpdir(), 'toucan-orchestrator-endpoint-'))
  const records = createOrchestrationStore({ directory })
  const endpoint = createOrchestratorEndpoint({ records, now: () => '2026-09-30T12:00:00.000Z' })
  return { directory, records, endpoint }
}

async function call(
  grant: OrchestratorGrant,
  command: string,
  args?: unknown,
  token: string | null = grant.environment[ORCHESTRATOR_TOKEN_ENV]
): Promise<{ status: number; body: { ok: boolean; error?: string; record?: unknown; ticket?: unknown } }> {
  const response = await fetch(grant.environment[ORCHESTRATOR_URL_ENV], {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token === null ? {} : { Authorization: `Bearer ${token}` }) },
    body: JSON.stringify({ command, args })
  })
  return { status: response.status, body: (await response.json()) as never }
}

const plan = {
  task: 'Ship orchestrator mode',
  targetBranch: 'main',
  tickets: [
    { id: '33', title: 'Foundation' },
    { id: '34', title: 'Spawn', blockedBy: ['33'] }
  ]
}

test('the listener binds with the first grant and closes with the last revoke', async () => {
  const { endpoint } = harness()
  assert.equal(endpoint.listening(), false)
  const first = await endpoint.grant('orchestrator-1', { provider: 'claude', projectPath: 'D:\\project' })
  const second = await endpoint.grant('orchestrator-2', { provider: 'claude', projectPath: 'D:\\project' })
  assert.ok(first && second)
  assert.equal(endpoint.listening(), true)
  assert.match(first.environment[ORCHESTRATOR_URL_ENV], /^http:\/\/127\.0\.0\.1:\d+\/orchestrate$/)
  assert.notEqual(first.environment[ORCHESTRATOR_TOKEN_ENV], second.environment[ORCHESTRATOR_TOKEN_ENV])
  first.revoke()
  assert.equal(endpoint.listening(), true)
  second.revoke()
  assert.equal(endpoint.listening(), false)
  await endpoint.close()
})

test('plan set, plan show and ticket update round-trip through the record', async () => {
  const { directory, endpoint } = harness()
  const grant = (await endpoint.grant('orchestrator-1', { provider: 'claude', projectPath: 'D:\\project' }))!
  grant.setConversation('conversation-1')
  try {
    assert.deepEqual((await call(grant, 'plan show')).body, { ok: true, record: null })

    const set = await call(grant, 'plan set', plan)
    assert.equal(set.status, 200)
    const updated = await call(grant, 'ticket update', { id: '34', fields: { attempts: 1, mergeStatus: 'unmerged' } })
    assert.equal(updated.status, 200)
    assert.deepEqual(updated.body.ticket, {
      id: '34',
      title: 'Spawn',
      blockedBy: ['33'],
      attempts: 1,
      mergeStatus: 'unmerged'
    })

    const shown = await call(grant, 'plan show')
    assert.equal((shown.body.record as { task: string }).task, 'Ship orchestrator mode')
    // What the endpoint wrote is what a restarted Toucan reads.
    const reread = await createOrchestrationStore({ directory }).read({
      provider: 'claude',
      conversationId: 'conversation-1'
    })
    assert.deepEqual(reread, shown.body.record)
  } finally {
    await endpoint.close()
  }
})

test('a missing, wrong or revoked token is refused before anything is read', async () => {
  const { endpoint } = harness()
  const grant = (await endpoint.grant('orchestrator-1', { provider: 'claude', projectPath: 'D:\\project' }))!
  const other = (await endpoint.grant('orchestrator-2', { provider: 'claude', projectPath: 'D:\\project' }))!
  grant.setConversation('conversation-1')
  try {
    assert.equal((await call(grant, 'plan show', undefined, null)).status, 401)
    assert.equal((await call(grant, 'usage', undefined, null)).status, 401)
    const wrong = await call(grant, 'plan show', undefined, 'not-the-token')
    assert.equal(wrong.status, 401)
    assert.match(wrong.body.error ?? '', /missing, wrong or revoked/)

    grant.revoke()
    // The other grant keeps the listener up, so this is the token being refused, not a closed port.
    assert.equal((await call(grant, 'plan show')).status, 401)
    assert.equal((await call(other, 'plan show')).status, 409)
  } finally {
    await endpoint.close()
  }
})

test('a relaunch replaces the node grant, and the old handle cannot revoke the new one', async () => {
  const { endpoint } = harness()
  const before = (await endpoint.grant('orchestrator-1', { provider: 'claude', projectPath: 'D:\\project' }))!
  const after = (await endpoint.grant('orchestrator-1', { provider: 'claude', projectPath: 'D:\\project' }))!
  after.setConversation('conversation-1')
  try {
    assert.equal((await call(before, 'plan show', undefined, before.environment[ORCHESTRATOR_TOKEN_ENV])).status, 401)
    // The old child exiting late revokes its own, already-dead grant - nothing else.
    before.revoke()
    assert.equal((await call(after, 'plan show')).status, 200)
  } finally {
    await endpoint.close()
  }
})

test('a call is scoped to the orchestrator project: another project record is refused', async () => {
  const { records, endpoint } = harness()
  // The same conversation, reopened as an orchestrator in a different project.
  const first = (await endpoint.grant('orchestrator-1', { provider: 'claude', projectPath: 'D:\\project' }))!
  first.setConversation('conversation-1')
  const elsewhere = (await endpoint.grant('orchestrator-2', { provider: 'claude', projectPath: 'D:\\other' }))!
  elsewhere.setConversation('conversation-1')
  try {
    assert.equal((await call(first, 'plan set', plan)).status, 200)

    for (const [command, args] of [
      ['plan show', undefined],
      ['plan set', plan],
      ['ticket update', { id: '33', fields: { attempts: 3 } }]
    ] as const) {
      const reply = await call(elsewhere, command, args)
      assert.equal(reply.status, 403, command)
      assert.match(reply.body.error ?? '', /another project/)
    }
    const kept = await records.read({ provider: 'claude', conversationId: 'conversation-1' })
    assert.equal(kept?.projectPath, 'D:\\project')
    assert.equal(kept?.tickets[0]?.attempts, 0)
    // Path identity, not spelling: the same checkout in another case is the same project.
    const sameProject = (await endpoint.grant('orchestrator-3', { provider: 'claude', projectPath: 'd:/project/' }))!
    sameProject.setConversation('conversation-1')
    assert.equal((await call(sameProject, 'plan show')).status, 200)
  } finally {
    await endpoint.close()
  }
})

test('invalid input and unknown commands are refused with a reason', async () => {
  const { endpoint } = harness()
  const grant = (await endpoint.grant('orchestrator-1', { provider: 'claude', projectPath: 'D:\\project' }))!
  grant.setConversation('conversation-1')
  try {
    const unknown = await call(grant, 'merge')
    assert.equal(unknown.status, 400)
    assert.match(unknown.body.error ?? '', /unknown command/)
    assert.equal((await call(grant, 'plan set', { task: 'no branch', tickets: [] })).status, 400)
    const early = await call(grant, 'ticket update', { id: '33', fields: { attempts: 1 } })
    assert.equal(early.status, 404)
    assert.match(early.body.error ?? '', /plan set first/)
  } finally {
    await endpoint.close()
  }
})

test('usage reads only the authenticated grant provider and preserves explicit missing or failed state', async () => {
  let claudeAttempt = 0
  const records = createOrchestrationStore({ directory: mkdtempSync(join(tmpdir(), 'toucan-orchestrator-usage-')) })
  const providerUsage = createProviderUsage({
    readers: {
      claude: {
        read: () => {
          claudeAttempt += 1
          if (claudeAttempt === 1) return { fiveHour: { usedPercent: 61 } }
          throw new Error('offline')
        }
      },
      codex: { read: () => null }
    },
    ttlMs: 60_000,
    now: () => 50
  })
  const endpoint = createOrchestratorEndpoint({ records, providerUsage })
  const claude = (await endpoint.grant('orchestrator-claude', { provider: 'claude', projectPath: 'D:\\project' }))!
  const codex = (await endpoint.grant('orchestrator-codex', { provider: 'codex', projectPath: 'D:\\project' }))!
  claude.setConversation('claude-conversation')
  codex.setConversation('codex-conversation')
  try {
    assert.deepEqual((await call(claude, 'usage')).body, {
      ok: true,
      provider: 'claude',
      usage: { status: { fiveHour: { usedPercent: 61 } }, readAt: 50, stale: false },
      state: 'available',
      pacing: { state: 'unknown' }
    })
    assert.deepEqual((await call(codex, 'usage')).body, {
      ok: true,
      provider: 'codex',
      usage: null,
      state: 'missing',
      pacing: { state: 'unknown' }
    })
    assert.deepEqual((await call(claude, 'usage')).body, {
      ok: true,
      provider: 'claude',
      usage: { status: { fiveHour: { usedPercent: 61 } }, readAt: 50, stale: true },
      state: 'failed',
      pacing: { state: 'unknown' }
    })
    assert.equal((await call(claude, 'usage', { force: true })).status, 400)
  } finally {
    await endpoint.close()
  }
})

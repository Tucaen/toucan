import { strict as assert } from 'node:assert'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'
import { createOrchestrationStore } from '../src/main/orchestration-store'
import {
  createOrchestratorEndpoint,
  type OrchestratorGrant,
  type TicketSessionControl,
  type TicketSessionState
} from '../src/main/orchestrator-endpoint'
import type { TicketSpawner } from '../src/main/ticket-spawner'
import type { AgentDecisionResponseContent, AgentPromptResult } from '../src/shared/agent'
import { ORCHESTRATOR_TOKEN_ENV, ORCHESTRATOR_URL_ENV } from '../src/shared/orchestration'
import type { SessionOutcomeIdentity, SessionOutcomeRecord } from '../src/shared/session-outcome'

// The orchestrator's view of and reach into its ticket sessions (#35): `status`, `outcome` and
// `followup`. A follow-up may answer a ticket session's question, never its tool-permission prompt.

const plan = {
  task: 'Ship orchestrator mode',
  targetBranch: 'main',
  tickets: [
    { id: '34', title: 'Spawn' },
    { id: '35', title: 'Wake', blockedBy: ['34'] }
  ]
}

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

const outcomeRecord = {
  title: '#34 Spawn',
  status: 'active',
  turns: 2,
  updatedAt: '2026-09-30T12:00:00.000Z',
  commit: 'abc1234',
  branch: 'ticket/34',
  filesTouched: ['src/a.ts', 'src/b.ts'],
  filesOmitted: 0,
  failures: [],
  toolFailures: [],
  toolFailuresOmitted: 0,
  lastResult: 'Done. npm test passed.',
  asks: ['/implement #34 Spawn'],
  task: '/implement #34 Spawn'
} as unknown as SessionOutcomeRecord

function control(states: Record<string, TicketSessionState>) {
  const sent: Array<{ nodeId: string; text: string; via: 'start' | 'whenIdle' }> = []
  const answered: Array<{ nodeId: string; requestId: string; content: AgentDecisionResponseContent }> = []
  const outcomeReads: SessionOutcomeIdentity[] = []
  let whenIdle: (nodeId: string) => Promise<AgentPromptResult> = async () => ({ ok: true })
  const sessions: TicketSessionControl = {
    state: (nodeId) => states[nodeId],
    startPrompt(nodeId, text) {
      sent.push({ nodeId, text, via: 'start' })
      return { ok: true }
    },
    promptWhenIdle(nodeId, text) {
      sent.push({ nodeId, text, via: 'whenIdle' })
      return whenIdle(nodeId)
    },
    answerQuestion(nodeId, requestId, content) {
      answered.push({ nodeId, requestId, content })
      return { ok: true }
    },
    outcome: async (identity) => {
      outcomeReads.push(identity)
      return identity.conversationId === 'conversation-34'
        ? { path: 'C:\\outcomes\\toucan--spawn--abcd.md', record: outcomeRecord }
        : undefined
    }
  }
  return {
    sessions,
    sent,
    answered,
    outcomeReads,
    setWhenIdle: (next: typeof whenIdle) => {
      whenIdle = next
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
    body: (await response.json()) as { ok: boolean; error?: string } & Record<string, never>
  }
}

async function spawned(states: Record<string, TicketSessionState>) {
  const bound: Array<{ nodeId: string; ticketId: string; orchestratorNodeId: string }> = []
  const fake = control(states)
  const endpoint = createOrchestratorEndpoint({
    records: createOrchestrationStore({ directory: mkdtempSync(join(tmpdir(), 'toucan-orchestrator-ticket-')) }),
    spawner,
    ticketSessions: fake.sessions,
    onTicketSpawned: (nodeId, binding) => bound.push({ nodeId, ...binding }),
    followupAckMs: 20
  })
  const grant = (await endpoint.grant('orchestrator-1', { provider: 'claude', projectPath: 'D:\\project' }))!
  grant.setConversation('conversation-1')
  assert.equal((await call(grant, 'plan set', plan)).status, 200)
  assert.equal((await call(grant, 'spawn', { ticket: '34', model: 'm', effort: 'high' })).status, 200)
  return { endpoint, grant, bound, ...fake }
}

const permission = { title: 'Run npm install' }
const question = {
  id: 'q1',
  message: 'Which store?',
  questions: [
    {
      id: 'store',
      question: 'Which store should it use?',
      options: [{ value: 'json', label: 'JSON' }],
      input: 'select' as const,
      multiSelect: false,
      required: true,
      customAnswerId: 'store__other'
    }
  ]
}

test('a spawned ticket session is bound to its orchestrator for waking', async () => {
  const { endpoint, bound } = await spawned({})
  try {
    assert.deepEqual(bound, [
      {
        nodeId: 'node-34',
        ticketId: '34',
        orchestratorNodeId: 'orchestrator-1',
        provider: 'claude',
        conversationId: 'conversation-34'
      }
    ])
  } finally {
    await endpoint.close()
  }
})

test('status lists every ticket session with its state, pending permission prompts and questions', async () => {
  const { endpoint, grant } = await spawned({ 'node-34': { status: 'working', permission, questions: [question] } })
  try {
    const reply = await call(grant, 'status')
    assert.equal(reply.status, 200)
    const [first, second] = reply.body.tickets
    assert.equal(first.id, '34')
    assert.equal(first.state, 'working')
    assert.deepEqual(first.permissionPrompt, { title: 'Run npm install', answeredBy: 'human' })
    assert.equal(first.questions[0].id, 'q1')
    assert.equal(first.questions[0].questions[0].question, 'Which store should it use?')
    assert.equal(first.session.branch, 'ticket/34')
    assert.equal(second.id, '35')
    assert.equal(second.state, 'not spawned')
    assert.deepEqual(reply.body.pendingPermissionPrompts, ['34'])
  } finally {
    await endpoint.close()
  }
})

test('status reads a ticket session Toucan is not running as not running', async () => {
  const { endpoint, grant } = await spawned({})
  try {
    assert.equal((await call(grant, 'status')).body.tickets[0].state, 'not running')
  } finally {
    await endpoint.close()
  }
})

test('a restarted Codex endpoint recovers status, outcome and followup through the durable session identity', async () => {
  const records = createOrchestrationStore({ directory: mkdtempSync(join(tmpdir(), 'toucan-codex-restart-')) })
  const beforeRestart = createOrchestratorEndpoint({ records, spawner })
  const firstGrant = (await beforeRestart.grant('codex-orchestrator', {
    provider: 'codex',
    projectPath: 'D:\\project'
  }))!
  firstGrant.setConversation('codex-conversation')
  assert.equal((await call(firstGrant, 'plan set', plan)).status, 200)
  assert.equal((await call(firstGrant, 'spawn', { ticket: '34', model: 'gpt', effort: 'high' })).status, 200)
  await beforeRestart.close()

  const restartedControl = control({ 'node-34': { status: 'ready', questions: [] } })
  const restarted = createOrchestratorEndpoint({ records, ticketSessions: restartedControl.sessions })
  const resumedGrant = (await restarted.grant('codex-orchestrator', {
    provider: 'codex',
    projectPath: 'D:\\project'
  }))!
  resumedGrant.setConversation('codex-conversation')
  try {
    assert.equal((await call(resumedGrant, 'status')).body.tickets[0].state, 'ready')
    assert.equal((await call(resumedGrant, 'outcome', { ticket: '34' })).status, 200)
    assert.deepEqual(restartedControl.outcomeReads, [{ provider: 'codex', conversationId: 'conversation-34' }])
    assert.equal((await call(resumedGrant, 'followup', { ticket: '34', text: 'continue' })).status, 200)
    assert.deepEqual(restartedControl.sent, [{ nodeId: 'node-34', text: 'continue', via: 'start' }])
  } finally {
    await restarted.close()
  }
})

test('outcome names the record path and its fields', async () => {
  const { endpoint, grant } = await spawned({})
  try {
    const reply = await call(grant, 'outcome', { ticket: '34' })
    assert.equal(reply.status, 200)
    assert.equal(reply.body.path, 'C:\\outcomes\\toucan--spawn--abcd.md')
    assert.equal(reply.body.fields.status, 'active')
    assert.deepEqual(reply.body.fields.filesTouched, ['src/a.ts', 'src/b.ts'])
    assert.equal(reply.body.fields.lastResult, 'Done. npm test passed.')
    assert.equal((await call(grant, 'outcome', { ticket: '35' })).status, 409)
    assert.equal((await call(grant, 'outcome', { ticket: 'nope' })).status, 400)
  } finally {
    await endpoint.close()
  }
})

test('followup prompts an idle ticket session and returns without waiting for its turn', async () => {
  const { endpoint, grant, sent } = await spawned({ 'node-34': { status: 'ready', questions: [] } })
  try {
    const reply = await call(grant, 'followup', { ticket: '34', text: 'Also cover the empty case.' })
    assert.equal(reply.status, 200)
    assert.equal(reply.body.delivered, 'prompt')
    assert.deepEqual(sent, [{ nodeId: 'node-34', text: 'Also cover the empty case.', via: 'start' }])
  } finally {
    await endpoint.close()
  }
})

test('followup steers a working ticket session, and reports a queued one rather than waiting for the turn', async () => {
  const { endpoint, grant, sent, setWhenIdle } = await spawned({ 'node-34': { status: 'working', questions: [] } })
  try {
    assert.equal((await call(grant, 'followup', { ticket: '34', text: 'steer' })).body.delivered, 'steered')
    setWhenIdle(() => new Promise(() => undefined))
    assert.equal((await call(grant, 'followup', { ticket: '34', text: 'queued' })).body.delivered, 'queued')
    assert.deepEqual(
      sent.map((entry) => entry.via),
      ['whenIdle', 'whenIdle']
    )
  } finally {
    await endpoint.close()
  }
})

test('followup answers a pending question with the text', async () => {
  const { endpoint, grant, sent, answered } = await spawned({ 'node-34': { status: 'working', questions: [question] } })
  try {
    const reply = await call(grant, 'followup', { ticket: '34', text: 'Use the durable JSON store.' })
    assert.equal(reply.status, 200)
    assert.equal(reply.body.delivered, 'answered')
    assert.deepEqual(answered, [
      { nodeId: 'node-34', requestId: 'q1', content: { store__other: 'Use the durable JSON store.' } }
    ])
    assert.equal(sent.length, 0)
  } finally {
    await endpoint.close()
  }
})

test('followup never answers a tool-permission prompt: that stays with the human', async () => {
  const { endpoint, grant, sent, answered } = await spawned({
    'node-34': { status: 'working', permission, questions: [question] }
  })
  try {
    const reply = await call(grant, 'followup', { ticket: '34', text: 'allow it' })
    assert.equal(reply.status, 409)
    assert.match(reply.body.error ?? '', /tool-permission prompt/)
    assert.match(reply.body.error ?? '', /human/)
    assert.equal(sent.length, 0)
    assert.equal(answered.length, 0)
  } finally {
    await endpoint.close()
  }
})

test('followup refuses a ticket without a running session, and needs text', async () => {
  const { endpoint, grant } = await spawned({})
  try {
    assert.equal((await call(grant, 'followup', { ticket: '34', text: 'hello' })).status, 409)
    assert.equal((await call(grant, 'followup', { ticket: '35', text: 'hello' })).status, 409)
    assert.equal((await call(grant, 'followup', { ticket: '34' })).status, 400)
  } finally {
    await endpoint.close()
  }
})

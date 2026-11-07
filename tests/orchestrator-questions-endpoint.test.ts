import { strict as assert } from 'node:assert'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'
import { createOrchestrationStore } from '../src/main/orchestration-store'
import {
  createOrchestratorEndpoint,
  type OrchestratorGrant,
  type OrchestratorEndpointOptions,
  type TicketSessionControl
} from '../src/main/orchestrator-endpoint'
import {
  ORCHESTRATOR_TOKEN_ENV,
  ORCHESTRATOR_URL_ENV,
  recordTicketSession,
  type OrchestrationQuestion,
  type OrchestrationRecord
} from '../src/shared/orchestration'
import type { SessionOutcomeRecord } from '../src/shared/session-outcome'

// Pinned open questions over the orchestrator endpoint (#2): `question add`, `question resolve`,
// `question list`, the open questions in `status`, auto-resolve when a ticket settles, and the
// untruncated final report `outcome --full` hands the orchestrator to copy a question from.

type Body = {
  ok: boolean
  error?: string
  question?: OrchestrationQuestion
  questions?: OrchestrationQuestion[]
  openQuestions?: OrchestrationQuestion[]
  changed?: boolean
  report?: string | null
  reportUnavailable?: string
  fields?: { lastResult?: string }
}

async function call(
  grant: OrchestratorGrant,
  command: string,
  args?: unknown
): Promise<{ status: number; body: Body }> {
  const response = await fetch(grant.environment[ORCHESTRATOR_URL_ENV], {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${grant.environment[ORCHESTRATOR_TOKEN_ENV]}`
    },
    body: JSON.stringify({ command, args })
  })
  return { status: response.status, body: (await response.json()) as Body }
}

const plan = {
  task: 'Pin questions',
  targetBranch: 'main',
  tickets: [
    { id: '3', title: 'Desktop strip' },
    { id: '4', title: 'Phone strip' }
  ]
}
const key = { provider: 'claude' as const, conversationId: 'conversation-1' }
const markdown = 'Left or right?\n\n![shot](file:///D:/Development/toucan/.toucan-scratch/a%20b.png)'

async function harness(options: Partial<OrchestratorEndpointOptions> = {}, directory?: string) {
  const dir = directory ?? mkdtempSync(join(tmpdir(), 'toucan-orchestrator-questions-'))
  const records = createOrchestrationStore({ directory: dir })
  const changes: OrchestrationRecord[] = []
  const endpoint = createOrchestratorEndpoint({
    records,
    now: () => '2026-11-03T12:00:00.000Z',
    questionsChanged: (record) => changes.push(record),
    ...options
  })
  const grant = (await endpoint.grant('orchestrator-1', { provider: 'claude', projectPath: 'D:\\project' }))!
  grant.setConversation('conversation-1')
  return {
    dir,
    records,
    changes,
    grant,
    close: async () => {
      grant.revoke()
      await endpoint.close()
    }
  }
}

test('add keeps clickable options and --multi, refuses bad ones, and list and status carry them', async () => {
  const h = await harness()
  try {
    await call(h.grant, 'plan set', plan)
    const added = await call(h.grant, 'question add', {
      ticket: '3',
      markdown,
      options: ['Left', { label: 'Right', description: 'newer' }],
      multiSelect: true
    })
    assert.equal(added.status, 200)
    assert.deepEqual(added.body.question?.options, [{ label: 'Left' }, { label: 'Right', description: 'newer' }])
    assert.equal(added.body.question?.multiSelect, true)
    assert.equal((await call(h.grant, 'question add', { markdown: 'Plain?' })).body.question?.options, undefined)
    assert.deepEqual(
      (await call(h.grant, 'question list')).body.questions?.map((question) => question.options?.length),
      [2, undefined]
    )
    assert.equal((await call(h.grant, 'question add', { markdown, options: [] })).status, 400)
    assert.equal((await call(h.grant, 'question add', { markdown, multiSelect: true })).status, 400)
  } finally {
    await h.close()
  }
})

test('add stores the markdown verbatim and returns its id; list and status show it; resolve closes it', async () => {
  const h = await harness()
  try {
    await call(h.grant, 'plan set', plan)
    const added = await call(h.grant, 'question add', { ticket: '3', markdown })
    assert.equal(added.status, 200)
    assert.equal(added.body.question?.id, 'Q1')
    assert.equal(added.body.question?.markdown, markdown)
    assert.equal((await call(h.grant, 'question add', { markdown: 'General?' })).body.question?.id, 'Q2')
    assert.equal(h.changes.length, 2)

    const listed = await call(h.grant, 'question list')
    assert.deepEqual(
      listed.body.questions?.map((question) => [question.id, question.ticketId, question.markdown]),
      [
        ['Q1', '3', markdown],
        ['Q2', undefined, 'General?']
      ]
    )
    assert.deepEqual(
      (await call(h.grant, 'status')).body.openQuestions?.map((question) => question.id),
      ['Q1', 'Q2']
    )

    const resolved = await call(h.grant, 'question resolve', { id: 'q1', note: 'left' })
    assert.equal(resolved.status, 200)
    assert.equal(resolved.body.changed, true)
    assert.equal(resolved.body.question?.resolution, 'left')
    assert.equal(h.changes.length, 3)
    const again = await call(h.grant, 'question resolve', { id: 'Q1' })
    assert.equal(again.body.changed, false)
    assert.equal(h.changes.length, 3)

    assert.deepEqual(
      (await call(h.grant, 'question list')).body.questions?.map((question) => question.id),
      ['Q2']
    )
    assert.deepEqual(
      (await call(h.grant, 'question list', { all: true })).body.questions?.map((question) => question.id),
      ['Q1', 'Q2']
    )
    assert.equal((await call(h.grant, 'question resolve', { id: 'Q9' })).status, 404)
    assert.equal((await call(h.grant, 'question add', { ticket: 'nope', markdown })).status, 400)
    assert.equal((await call(h.grant, 'question add', {})).status, 400)
  } finally {
    await h.close()
  }
})

test('questions need a plan, and survive a Toucan restart and a re-plan', async () => {
  const first = await harness()
  try {
    assert.equal((await call(first.grant, 'question add', { markdown })).status, 404)
    await call(first.grant, 'plan set', plan)
    await call(first.grant, 'question add', { ticket: '4', markdown })
  } finally {
    await first.close()
  }
  const restarted = await harness({}, first.dir)
  try {
    assert.equal((await call(restarted.grant, 'plan set', { ...plan, tickets: [plan.tickets[0]] })).status, 200)
    const listed = await call(restarted.grant, 'question list')
    assert.deepEqual(
      listed.body.questions?.map((question) => [question.id, question.markdown]),
      [['Q1', markdown]]
    )
    assert.equal((await call(restarted.grant, 'question add', { markdown: 'next' })).body.question?.id, 'Q2')
  } finally {
    await restarted.close()
  }
})

test('a ticket recorded merged or answered resolves its questions and republishes the state', async () => {
  const h = await harness({
    merge: { run: async () => ({ ok: true, commit: 'abc1234', upstream: 'origin/main' }) },
    cleanup: { run: async () => ({ removed: [], retained: [] }), answeredRefusal: async () => undefined },
    ticketSessions: { state: () => ({ status: 'ready', questions: [] }) } as unknown as TicketSessionControl
  })
  try {
    await call(h.grant, 'plan set', plan)
    for (const id of ['3', '4']) {
      await h.records.update(key, (current) => ({
        value: recordTicketSession(current!, id, { nodeId: `node-${id}`, conversationId: `c-${id}` }, 'now'),
        result: undefined
      }))
    }
    await call(h.grant, 'question add', { ticket: '3', markdown: 'a' })
    await call(h.grant, 'question add', { ticket: '4', markdown: 'b' })
    await call(h.grant, 'question add', { markdown: 'c' })
    const before = h.changes.length

    assert.equal((await call(h.grant, 'merge', { ticket: '3', tested: 'abc1234' })).status, 200)
    assert.equal(h.changes.length, before + 1)
    assert.equal((await call(h.grant, 'ticket update', { id: '4', fields: { mergeStatus: 'answered' } })).status, 200)
    assert.equal(h.changes.length, before + 2)
    const all = (await call(h.grant, 'question list', { all: true })).body.questions!
    assert.deepEqual(
      all.map((question) => [question.id, question.resolution ?? null]),
      [
        ['Q1', 'ticket 3 merged'],
        ['Q2', 'ticket 4 answered'],
        ['Q3', null]
      ]
    )
    // An update that settles nothing does not republish.
    await call(h.grant, 'ticket update', { id: '3', fields: { title: 'Renamed' } })
    assert.equal(h.changes.length, before + 2)
  } finally {
    await h.close()
  }
})

test('outcome --full adds the untruncated final report from the live session', async () => {
  const long = `${'x'.repeat(700)} [shot](file:///D:/shot.png)`
  let report: string | undefined = long
  const h = await harness({
    ticketSessions: {
      state: () => ({ status: 'ready', questions: [] }),
      finalReport: (nodeId: string) => (nodeId === 'node-3' ? report : undefined),
      outcome: async () => ({
        path: 'C:\\outcomes\\ticket-3.md',
        record: { lastResult: `${long.slice(0, 597)}...` } as unknown as SessionOutcomeRecord
      })
    } as unknown as TicketSessionControl
  })
  try {
    await call(h.grant, 'plan set', plan)
    await h.records.update(key, (current) => ({
      value: recordTicketSession(current!, '3', { nodeId: 'node-3', conversationId: 'c-3' }, 'now'),
      result: undefined
    }))
    const excerpt = await call(h.grant, 'outcome', { ticket: '3' })
    assert.equal(excerpt.status, 200)
    assert.equal(excerpt.body.report, undefined)
    const full = await call(h.grant, 'outcome', { ticket: '3', full: true })
    assert.equal(full.status, 200)
    assert.equal(full.body.report, long)
    report = undefined
    const gone = await call(h.grant, 'outcome', { ticket: '3', full: true })
    assert.equal(gone.status, 200)
    assert.equal(gone.body.report, null)
    assert.match(gone.body.reportUnavailable ?? '', /not running/)
    assert.equal((await call(h.grant, 'outcome', { ticket: '3', full: 'yes' })).status, 400)
  } finally {
    await h.close()
  }
})

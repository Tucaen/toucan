import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { activityFromUpdate } from '../src/shared/agent-activity'
import { delegationEvidenceFrom, delegationEvidenceRows } from '../src/shared/delegation-evidence'
import { foldAgentEvent, initialAgentTranscriptState } from '../src/shared/agent-transcript'
import type { AgentActivity } from '../src/shared/agent'

const call: AgentActivity = { id: 'worker', toolName: 'Agent', subagent: true, rawInput: { model: 'haiku' } }

test('namespaced built-in delegations retain model evidence while MCP collisions do not', () => {
  for (const toolName of ['functions.Agent', 'tools.task', 'functions:Task']) {
    assert.equal(delegationEvidenceFrom({ ...call, toolName, subagent: undefined }).requestedModel, 'haiku')
  }
  assert.deepEqual(delegationEvidenceFrom({ ...call, toolName: 'mcp__tracker__task', subagent: undefined }), {})
  assert.deepEqual(
    delegationEvidenceFrom({
      ...call,
      subagent: undefined,
      rawInput: { server: 'tracker', tool: 'task', model: 'haiku' }
    }),
    {}
  )
})

test('explicit provider thinking tokens remain part of output, not an extra total', () => {
  const evidence = delegationEvidenceFrom({
    ...call,
    rawOutput: {
      status: 'completed',
      agentId: 'a',
      totalTokens: 11390,
      usage: {
        input_tokens: 8,
        output_tokens: 1512,
        cache_creation_input_tokens: 1880,
        cache_read_input_tokens: 7990,
        output_tokens_details: { thinking_tokens: 1166 }
      }
    }
  })
  assert.equal(evidence.usage?.reasoning, 1166)
  assert.equal(evidence.usage?.output, 1512)
  assert.equal(evidence.usage?.total, 11390)
})

test('partial provider totals survive ACP mapping, repeated updates and transcript replay', () => {
  const updates = [
    activityFromUpdate({
      toolCallId: 'worker',
      status: 'in_progress',
      rawInput: { model: 'haiku' },
      _meta: { claudeCode: { toolName: 'Agent', subagent: true } }
    }),
    activityFromUpdate({
      toolCallId: 'worker',
      status: 'completed',
      rawOutput: [
        {
          type: 'text',
          text: 'Found 12 exports.\nagentId: worker (use SendMessage to continue)\n<usage>\ntotal_tokens: 1420\ntool_uses: 2\nduration_ms: 900\n</usage>'
        }
      ]
    })
  ]
  const fold = (activities: AgentActivity[]) =>
    activities.reduce(
      (state, activity) => foldAgentEvent(state, { type: 'activity', activity }, 100),
      initialAgentTranscriptState()
    )
  const live = fold(updates)
  const replay = fold([...updates, updates[1]])
  assert.deepEqual(replay.activities, live.activities)
  assert.equal(replay.transcript.length, 1)
  assert.deepEqual(live.activities.worker.delegationEvidence?.usage, {
    scope: 'worker-invocation',
    source: 'agent-result-trailer',
    total: 1420
  })
  assert.equal(live.activities.worker.delegationEvidence?.confirmedModels, undefined)
  assert.match(
    delegationEvidenceRows(live.activities.worker).find((row) => row.label === 'Worker invocation tokens')!.value,
    /input: unavailable.*reasoning: unavailable/
  )
})

test('confirmed substitutions and multiple models are separate from the requested alias', () => {
  const evidence = delegationEvidenceFrom({
    ...call,
    rawOutput: {
      status: 'completed',
      agentId: 'a',
      resolvedModel: 'claude-sonnet-4',
      modelsUsed: ['claude-sonnet-4', 'claude-haiku-4-5'],
      totalTokens: 400,
      usage: { input_tokens: 120, output_tokens: 80, cache_read_input_tokens: 200, cache_creation_input_tokens: null }
    }
  })
  assert.equal(evidence.requestedModel, 'haiku')
  assert.deepEqual(evidence.confirmedModels, ['claude-sonnet-4', 'claude-haiku-4-5'])
  assert.equal(evidence.usage?.cacheWrite, undefined)
  assert.equal(evidence.usage?.cacheRead, 200)
})

test('missing, malformed and prose-only telemetry never becomes zero or confirmation', () => {
  for (const rawOutput of [
    undefined,
    'Used 42 tokens on haiku',
    '<usage>\ntotal_tokens: -4\n</usage>',
    '<usage>\ntotal_tokens: 9007199254740992\n</usage>',
    { model: 'haiku', usage: { input_tokens: 10 } },
    { status: 'completed', agentId: 'a', usage: { input_tokens: NaN, output_tokens: -1 } }
  ]) {
    assert.equal(delegationEvidenceFrom({ ...call, rawOutput }).usage, undefined)
    assert.equal(delegationEvidenceFrom({ ...call, rawOutput }).confirmedModels, undefined)
  }
  assert.deepEqual(
    delegationEvidenceFrom({ id: 'mcp', toolName: 'mcp__tracker__task', rawInput: { model: 'haiku' } }),
    {}
  )
})

test('overlapping outer and inner worker totals are displayed separately and never summed', () => {
  const total = (id: string, tokens: number): AgentActivity => ({
    ...call,
    id,
    rawOutput: `<usage>\ntotal_tokens: ${tokens}\n</usage>`
  })
  const parent = total('outer', 1000)
  const child = total('inner', 600)
  const rows = delegationEvidenceRows(parent, [child, child])
  assert.equal(rows.filter((row) => /worker tokens/i.test(row.label)).length, 1)
  assert.equal(rows.filter((row) => row.value.includes('total: 600')).length, 1)
  assert.equal(
    rows.some((row) => row.value.includes('1600')),
    false
  )
  assert.match(rows.find((row) => row.label === 'Accounting')!.value, /may overlap; not added/)
})

test('failed then retried calls retain the known failure without counting repeated patches as retries', () => {
  const updates: AgentActivity[] = [
    { ...call, status: 'failed' },
    { id: call.id, status: 'failed' },
    { id: call.id, status: 'in_progress' },
    { id: call.id, status: 'completed' }
  ]
  const state = updates.reduce(
    (state, activity) => foldAgentEvent(state, { type: 'activity', activity }, 100),
    initialAgentTranscriptState()
  )
  assert.deepEqual(state.activities.worker.delegationEvidence?.observedStatuses, ['failed', 'in_progress', 'completed'])
  assert.match(
    delegationEvidenceRows(state.activities.worker).find((row) => row.label === 'Earlier outcome')!.value,
    /Failure reported/
  )
  assert.equal(state.transcript.length, 1)
})

test('Codex interrupted interactions and failed child steps remain visible with no guessed usage', () => {
  const rows = delegationEvidenceRows({ ...call, rawInput: { agentThreadId: 't' } }, [
    { id: 'interrupt', subagent: true, rawInput: { activityKind: 'interrupted' }, status: 'completed' },
    { id: 'check', title: 'Verification command', status: 'failed' }
  ])
  assert.equal(rows.find((row) => row.label === 'Observed outcome')!.value, 'Interrupted interaction reported')
  assert.equal(rows.find((row) => row.label === 'Failed calls')!.value, 'Verification command')
  assert.equal(rows.find((row) => row.label === 'Worker invocation tokens')!.value, 'Unavailable')
})

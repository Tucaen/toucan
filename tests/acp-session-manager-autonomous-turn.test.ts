import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'
import type { WebContents } from 'electron'
import {
  autonomousTurnSignal,
  backgroundTaskCount,
  backgroundTaskTypes,
  createAcpSessionManager,
  withForwardedSdkMessages
} from '../src/main/acp-session-manager'
import { createAgentEventBroker } from '../src/main/agent-event-broker'
import { createOrchestrationWaker } from '../src/main/orchestration-wake'
import { createSessionOutcomeIndexer } from '../src/main/session-outcome-indexer'
import { createSessionOutcomeStore, type SessionOutcomeStore } from '../src/main/session-outcome-store'
import type { SessionOutcomeRecord } from '../src/shared/session-outcome'

/**
 * claude-agent-acp's shape for the CIC-33 incident: the prompt starts a background task and its
 * turn ends, then the task's `<task-notification>` wakes the agent with no `session/prompt` in
 * flight. The second cycle's end is visible only as raw SDK messages, and only to a session that
 * opted into them - exactly as the real adapter forwards `_claude/sdkMessage`.
 */
function backgroundTaskAdapter(appPath: string): void {
  const directory = join(appPath, 'node_modules', '@agentclientprotocol', 'claude-agent-acp', 'dist')
  mkdirSync(directory, { recursive: true })
  writeFileSync(
    join(directory, 'index.js'),
    `
const readline = require('node:readline')
const lines = readline.createInterface({ input: process.stdin })
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n')
let raw = []
const update = (u) => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'live-session', update: u } })
const sdk = (message) => {
  if (raw.some((f) => f.type === message.type && (f.subtype === undefined || f.subtype === message.subtype)))
    send({ jsonrpc: '2.0', method: '_claude/sdkMessage', params: { sessionId: 'live-session', message } })
}
const say = (messageId, text) => update({ sessionUpdate: 'agent_message_chunk', messageId, content: { type: 'text', text } })
const edit = (toolCallId, path) => update({ sessionUpdate: 'tool_call', toolCallId, title: 'Edit', kind: 'edit', locations: [{ path }] })
lines.on('line', (line) => {
  const request = JSON.parse(line)
  if (request.method === 'initialize') {
    send({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } })
  } else if (request.method === 'session/new') {
    raw = request.params._meta?.claudeCode?.emitRawSDKMessages || []
    send({ jsonrpc: '2.0', id: request.id, result: { sessionId: 'live-session' } })
  } else if (request.method === 'session/prompt') {
    edit('c1', 'src/a.ts')
    update({ sessionUpdate: 'tool_call', toolCallId: 'c2', title: 'npm test', kind: 'execute' })
    // The backgrounded command is live when the turn ends; its settle empties the level again.
    sdk({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'b1', task_type: 'local_bash', description: 'npm test' }] })
    say('m1', 'The full suite is running in the background.')
    sdk({ type: 'result', subtype: 'success', num_turns: 3, origin: { kind: 'human' } })
    send({ jsonrpc: '2.0', id: request.id, result: { stopReason: 'end_turn' } })
    setTimeout(() => {
      sdk({ type: 'system', subtype: 'background_tasks_changed', tasks: [] })
      // The CLI's own notification echo is not forwarded live; the agent's reaction is.
      say('m2', 'Seven tests failed; fixing them.')
      edit('c3', 'src/b.ts')
      say('m3', 'Final report: all green.')
      sdk({ type: 'result', subtype: 'success', num_turns: 0, origin: { kind: 'task-notification' } })
      sdk({ type: 'result', subtype: 'success', num_turns: 4, origin: { kind: 'task-notification' } })
      sdk({ type: 'system', subtype: 'session_state_changed', state: 'idle' })
    }, 300)
  }
})
`,
    'utf8'
  )
}

async function until<T>(get: () => Promise<T | undefined> | T | undefined): Promise<T> {
  for (let attempt = 0; attempt < 300; attempt++) {
    const value = await get()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('condition not reached')
}

test('a turn the agent resumes on a task notification refreshes the record and wakes the orchestrator', async () => {
  const appPath = mkdtempSync(join(tmpdir(), 'toucan-autonomous-turn-'))
  backgroundTaskAdapter(appPath)
  const broker = createAgentEventBroker()
  const inner = createSessionOutcomeStore({ directory: join(appPath, 'session-outcomes') })
  const records: SessionOutcomeRecord[] = []
  const store: SessionOutcomeStore = {
    ...inner,
    update: (identity, change, naming) =>
      inner.update(
        identity,
        (previous) => {
          const next = change(previous)
          if (typeof next === 'object') records.push(next)
          return next
        },
        naming
      )
  }
  let head = '08a06f0'
  const indexer = createSessionOutcomeIndexer({
    broker,
    store,
    codeStateFor: async () => ({ commit: head }),
    // The fixture project lives under the OS temp root, which the index otherwise leaves out.
    temporaryDirectory: join(appPath, 'no-temp')
  })
  const delivered: string[] = []
  const waker = createOrchestrationWaker({
    deliver: async (_orchestrator, text) => {
      delivered.push(text)
      return { ok: true }
    },
    resolve: async () => null,
    outcome: async () => undefined,
    foldMs: 0
  })
  broker.observe((id, event) => waker.observe(id, event))
  waker.bind('node-1', {
    provider: 'claude',
    orchestratorNodeId: 'orchestrator',
    ticketId: 'CIC-33',
    conversationId: 'live-session'
  })
  const owner = { isDestroyed: () => false, send: () => {} } as unknown as WebContents
  const manager = createAcpSessionManager({ appPath, broker, sessionOutcomes: indexer })

  try {
    await manager.create({ id: 'node-1', provider: 'claude', cwd: appPath }, owner)
    await manager.prompt('node-1', 'Implement CIC-33 and end with a final report.')

    const first = await until(() => records[0])
    assert.equal(first.turns, 1)
    assert.equal(first.commit, '08a06f0')
    assert.equal(first.lastResult, 'The full suite is running in the background.')
    await until(() => delivered.length === 1 || undefined)
    assert.match(delivered[0], /#CIC-33 completed \(background work pending: 1 task\)/)
    // The turn is over but its shell is not: the count is live state, not only a turn_complete field.
    assert.deepEqual(manager.backgroundWork(), [{ id: 'node-1', tasks: 1, byType: { local_bash: 1 } }])
    assert.equal(broker.snapshot('node-1')?.backgroundTasks, 1)
    head = 'ab543d1'

    // The notification-driven cycle has no prompt of its own; its end is a turn boundary all the same.
    const second = await until(() => records.find((record) => record.lastResult === 'Final report: all green.'))
    assert.equal(second.commit, 'ab543d1')
    assert.equal(second.turns, 1, 'a task notification is not an ask, so it does not count as one')
    assert.deepEqual(second.filesTouched, ['src/a.ts', 'src/b.ts'])
    await until(() => delivered.length === 2 || undefined)
    assert.match(delivered[1], /#CIC-33 completed - /)
    assert.doesNotMatch(delivered[1], /background work pending/)

    // The placeholder result and the trailing idle close nothing: the cycle was already closed once.
    await waker.idle()
    assert.equal(delivered.length, 2)
    assert.equal(records.filter((record) => record.lastResult === 'Final report: all green.').length, 1)

    const snapshot = broker.snapshot('node-1')
    assert.equal(snapshot?.status, 'ready')
    assert.equal(snapshot?.backgroundTasks, 0, 'the task that woke the cycle is gone, so the node is idle again')
    assert.deepEqual(manager.backgroundWork(), [])
    const assistant = snapshot?.messages.filter((message) => message.role === 'assistant') ?? []
    assert.deepEqual(
      assistant.map((message) => [message.text, message.presentation]),
      [
        ['The full suite is running in the background.', 'final'],
        ['Seven tests failed; fixing them.', 'progress'],
        ['Final report: all green.', 'final']
      ]
    )
  } finally {
    manager.killAll()
  }
})

/**
 * A Claude adapter whose background-task level a test drives by prompt text: each line the prompt
 * carries is one SDK message, sent after the turn's own response so it lands between turns.
 */
function levelAdapter(appPath: string, script: unknown[][]): void {
  const directory = join(appPath, 'node_modules', '@agentclientprotocol', 'claude-agent-acp', 'dist')
  mkdirSync(directory, { recursive: true })
  writeFileSync(
    join(directory, 'index.js'),
    `
const readline = require('node:readline')
const lines = readline.createInterface({ input: process.stdin })
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n')
let raw = []
const sdk = (message) => {
  if (raw.some((f) => f.type === message.type && (f.subtype === undefined || f.subtype === message.subtype)))
    send({ jsonrpc: '2.0', method: '_claude/sdkMessage', params: { sessionId: 'live-session', message } })
}
const script = ${JSON.stringify(script)}
lines.on('line', (line) => {
  const request = JSON.parse(line)
  if (request.method === 'initialize') {
    send({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } })
  } else if (request.method === 'session/new') {
    raw = request.params._meta?.claudeCode?.emitRawSDKMessages || []
    send({ jsonrpc: '2.0', id: request.id, result: { sessionId: 'live-session' } })
  } else if (request.method === 'session/prompt') {
    send({ jsonrpc: '2.0', id: request.id, result: { stopReason: 'end_turn' } })
    let delay = 0
    for (const [wait, message] of script) {
      delay += wait
      setTimeout(() => sdk(message), delay)
    }
  }
})
`,
    'utf8'
  )
}

const level = (...types: string[]) => ({
  type: 'system',
  subtype: 'background_tasks_changed',
  tasks: types.map((task_type, index) => ({ task_id: `t${index}`, task_type }))
})

test('the live background count reaches every subscriber and the main-side query, only when it changes', async () => {
  const appPath = mkdtempSync(join(tmpdir(), 'toucan-background-count-'))
  levelAdapter(appPath, [
    [0, level('local_bash', 'local_agent')],
    // Same total, different tasks: nothing new for anyone to be told.
    [40, level('local_bash', 'local_monitor')],
    [40, level('local_bash', 'local_monitor')],
    // The CLI restarted inside the adapter: its tasks died with it.
    [40, { type: 'system', subtype: 'init' }],
    [40, level('local_bash')],
    // The cycle a finished task wakes opens on the CLI's `running`, before any output.
    [40, { type: 'system', subtype: 'session_state_changed', state: 'running' }]
  ])
  const broker = createAgentEventBroker()
  const counts: number[] = []
  broker.observe((_id, event) => {
    if (event.type === 'status' && event.backgroundTasks !== undefined) counts.push(event.backgroundTasks)
  })
  const owner = { isDestroyed: () => false, send: () => {} } as unknown as WebContents
  const manager = createAcpSessionManager({ appPath, broker })

  try {
    await manager.create({ id: 'node-1', provider: 'claude', cwd: appPath }, owner)
    assert.deepEqual(manager.backgroundWork(), [])
    await manager.prompt('node-1', 'go')

    await until(() => (manager.backgroundWork()[0]?.byType.local_monitor ? true : undefined))
    assert.deepEqual(manager.backgroundWork(), [
      { id: 'node-1', tasks: 2, byType: { local_bash: 1, local_monitor: 1 } }
    ])
    assert.equal(broker.snapshot('node-1')?.backgroundTasks, 2)

    // The restart empties it, then the new CLI's own task is counted afresh.
    await until(() => (broker.snapshot('node-1')?.backgroundTasks === 0 ? true : undefined))
    assert.deepEqual(manager.backgroundWork(), [])
    await until(() => (broker.snapshot('node-1')?.backgroundTasks === 1 ? true : undefined))

    // `running` with no prompt in flight is a cycle of its own, so the node reads Working at once.
    await until(() => (broker.snapshot('node-1')?.status === 'working' ? true : undefined))
    assert.equal(broker.snapshot('node-1')?.backgroundTasks, 1)
    assert.deepEqual(counts, [2, 0, 1])

    // Stopping the session takes its tasks with it: nothing is left to warn about.
    manager.kill('node-1')
    assert.deepEqual(manager.backgroundWork(), [])
  } finally {
    manager.killAll()
  }
})

test('background tasks are counted per type, unknown types included', () => {
  assert.deepEqual(backgroundTaskTypes(level('local_bash', 'local_agent', 'local_monitor', 'local_agent')), {
    local_bash: 1,
    local_agent: 2,
    local_monitor: 1
  })
  assert.deepEqual(backgroundTaskTypes({ type: 'system', subtype: 'background_tasks_changed', tasks: [{}] }), {
    unknown: 1
  })
  assert.deepEqual(backgroundTaskTypes(level()), {})
  assert.equal(backgroundTaskTypes({ type: 'system', subtype: 'init' }), null)
  assert.equal(backgroundTaskTypes({ type: 'system', subtype: 'background_tasks_changed', tasks: 'garbled' }), null)
})

test('autonomous cycles are read off results and idle, never off a placeholder', () => {
  assert.deepEqual(autonomousTurnSignal({ type: 'result', subtype: 'success', num_turns: 2 }), {
    end: 'result',
    failed: false,
    stopReason: 'end_turn'
  })
  assert.equal(autonomousTurnSignal({ type: 'result', subtype: 'success', num_turns: 0 }), null)
  assert.deepEqual(
    autonomousTurnSignal({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'boom' }),
    { end: 'result', failed: true, stopReason: 'end_turn', message: 'boom' }
  )
  assert.deepEqual(autonomousTurnSignal({ type: 'system', subtype: 'session_state_changed', state: 'idle' }), {
    end: 'idle'
  })
  assert.equal(autonomousTurnSignal({ type: 'system', subtype: 'session_state_changed', state: 'running' }), null)
  assert.equal(autonomousTurnSignal({ type: 'assistant' }), null)
})

test('the live background-task count is read off the replace-semantics level, never anything else', () => {
  const level = (tasks: unknown) => ({ type: 'system', subtype: 'background_tasks_changed', tasks })
  assert.equal(backgroundTaskCount(level([{ task_id: 'b1' }, { task_id: 'a1' }])), 2)
  assert.equal(backgroundTaskCount(level([])), 0)
  assert.equal(backgroundTaskCount(level('garbled')), null)
  assert.equal(backgroundTaskCount({ type: 'system', subtype: 'session_state_changed', state: 'idle' }), null)
  assert.equal(backgroundTaskCount({ type: 'result', subtype: 'success', num_turns: 2 }), null)
})

test('the raw-message opt-in keeps every sibling Claude option', () => {
  const configured = withForwardedSdkMessages({
    _meta: { claudeCode: { options: { plugins: [{ type: 'local', path: 'skills' }] } } }
  })
  assert.deepEqual(configured._meta?.claudeCode?.options, { plugins: [{ type: 'local', path: 'skills' }] })
  assert.ok(configured._meta?.claudeCode?.emitRawSDKMessages?.some((filter) => filter.type === 'result'))
  assert.ok(
    configured._meta?.claudeCode?.emitRawSDKMessages?.some(
      (filter) => filter.type === 'system' && filter.subtype === 'background_tasks_changed'
    )
  )
})

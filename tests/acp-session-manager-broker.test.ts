import { strict as assert } from 'node:assert'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import type { WebContents } from 'electron'
import { createAcpSessionManager } from '../src/main/acp-session-manager'
import { createAgentEventBroker } from '../src/main/agent-event-broker'
import type { AgentEvent, AgentEventEnvelope } from '../src/shared/agent'

/**
 * An adapter whose prompt turn parks on an approval (so it is provably still working), optionally
 * echoing the prompt back as a live `user_message_chunk` the way a provider might, and optionally
 * advertising the steering extension so a follow-up can be injected into the open turn.
 */
function promptingAdapter(appPath: string, behaviour: { echoPrompt?: boolean; steering?: boolean }): void {
  const directory = join(appPath, 'node_modules', '@agentclientprotocol', 'claude-agent-acp', 'dist')
  mkdirSync(directory, { recursive: true })
  writeFileSync(
    join(directory, 'index.js'),
    `
const readline = require('node:readline')
const lines = readline.createInterface({ input: process.stdin })
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n')
let pendingPrompt
lines.on('line', (line) => {
  const request = JSON.parse(line)
  if (request.method === 'initialize') {
    send({ jsonrpc: '2.0', id: request.id, result: {
      protocolVersion: 1,
      agentCapabilities: {},
      authMethods: [],
      ${behaviour.steering ? '_meta: { steering: { supported: true } },' : ''}
    } })
  } else if (request.method === 'session/new') {
    send({ jsonrpc: '2.0', id: request.id, result: { sessionId: 'live-session' } })
  } else if (request.method === 'session/prompt') {
    pendingPrompt = request.id
    ${
      behaviour.echoPrompt
        ? `send({ jsonrpc: '2.0', method: 'session/update', params: {
      sessionId: request.params.sessionId,
      update: { sessionUpdate: 'user_message_chunk', content: request.params.prompt[0] }
    } })`
        : ''
    }
    send({ jsonrpc: '2.0', id: 900, method: 'session/request_permission', params: {
      sessionId: request.params.sessionId,
      toolCall: { toolCallId: 'call-1', title: 'Run npm test', kind: 'execute' },
      options: [
        { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
        { optionId: 'reject', name: 'Reject', kind: 'reject_once' }
      ]
    } })
  } else if (request.method === '_session/steering') {
    send({ jsonrpc: '2.0', id: request.id, result: { outcome: 'injected' } })
  } else if (request.method === undefined && request.id === 900) {
    send({ jsonrpc: '2.0', id: pendingPrompt, result: { stopReason: 'end_turn' } })
  }
})
`,
    'utf8'
  )
}

async function until<T>(get: () => T | undefined): Promise<T> {
  for (let attempt = 0; attempt < 300; attempt++) {
    const value = get()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('condition not reached')
}

test('agent events fan out to broker subscribers, the owning renderer among them', async () => {
  const appPath = mkdtempSync(join(tmpdir(), 'toucan-broker-fanout-'))
  promptingAdapter(appPath, {})
  const broker = createAgentEventBroker()
  const ownerEvents: AgentEvent[] = []
  const owner = {
    isDestroyed: () => false,
    send: (_channel: string, envelope: AgentEventEnvelope) => ownerEvents.push(envelope.event)
  } as unknown as WebContents
  const remote: AgentEvent[] = []
  broker.subscribe('node-1', (event) => remote.push(event))
  const manager = createAcpSessionManager({ appPath, broker })

  try {
    const result = await manager.create({ id: 'node-1', provider: 'claude', cwd: appPath }, owner)

    assert.equal(result.status, 'ready')
    assert.ok(remote.some((event) => event.type === 'session' && event.sessionId === 'live-session'))
    // The renderer is one subscriber among N: it sees exactly the fanned-out stream.
    assert.deepEqual(ownerEvents, remote)
    assert.equal(broker.snapshot('node-1')?.status, 'ready')
  } finally {
    manager.killAll()
  }
})

test('an approval answered via one client is reflected in every subscriber stream and the snapshot', async () => {
  const appPath = mkdtempSync(join(tmpdir(), 'toucan-broker-approval-'))
  promptingAdapter(appPath, {})
  const broker = createAgentEventBroker()
  const ownerEvents: AgentEvent[] = []
  const owner = {
    isDestroyed: () => false,
    send: (_channel: string, envelope: AgentEventEnvelope) => ownerEvents.push(envelope.event)
  } as unknown as WebContents
  const remote: AgentEvent[] = []
  broker.subscribe('node-1', (event) => remote.push(event))
  const manager = createAcpSessionManager({ appPath, broker })

  try {
    await manager.create({ id: 'node-1', provider: 'claude', cwd: appPath }, owner)
    const turn = manager.prompt('node-1', 'run the tests')
    const approval = await until(() =>
      remote.find((event): event is Extract<AgentEvent, { type: 'approval' }> => event.type === 'approval')
    )
    assert.equal(broker.snapshot('node-1')?.approval?.id, approval.approvalId)

    // Answered here on behalf of "another client": the same operation IPC delegates to.
    manager.resolveApproval('node-1', approval.approvalId, 'allow')
    const result = await turn

    assert.equal(result.ok, true)
    const resolved = { type: 'approval_resolved', approvalId: approval.approvalId }
    assert.deepEqual(
      remote.filter((event) => event.type === 'approval_resolved'),
      [resolved]
    )
    assert.deepEqual(
      ownerEvents.filter((event) => event.type === 'approval_resolved'),
      [resolved]
    )
    assert.equal(broker.snapshot('node-1')?.approval, null)
  } finally {
    manager.killAll()
  }
})

test('killing a session closes its broker channel so a later incarnation starts clean', async () => {
  const appPath = mkdtempSync(join(tmpdir(), 'toucan-broker-close-'))
  promptingAdapter(appPath, {})
  const broker = createAgentEventBroker()
  const owner = { isDestroyed: () => false, send: () => {} } as unknown as WebContents
  const stale: AgentEvent[] = []
  broker.subscribe('node-1', (event) => stale.push(event))
  const manager = createAcpSessionManager({ appPath, broker })

  try {
    await manager.create({ id: 'node-1', provider: 'claude', cwd: appPath }, owner)
    manager.kill('node-1')
    assert.equal(broker.snapshot('node-1'), null)

    const before = stale.length
    await manager.create({ id: 'node-1', provider: 'claude', cwd: appPath }, owner)
    // The old subscription was retired with the session; only a fresh subscribe would see the new one.
    assert.equal(stale.length, before)
    assert.equal(broker.snapshot('node-1')?.status, 'ready')
  } finally {
    manager.killAll()
  }
})

test("a killed adapter's straggling stderr cannot resurrect the closed broker channel", async () => {
  const appPath = mkdtempSync(join(tmpdir(), 'toucan-broker-straggler-'))
  promptingAdapter(appPath, {})
  const broker = createAgentEventBroker()
  const owner = { isDestroyed: () => false, send: () => {} } as unknown as WebContents
  let stderr: PassThrough | undefined
  const manager = createAcpSessionManager({
    appPath,
    broker,
    // An in-process adapter that completes the handshake, so the session is fully established
    // before the kill: the leak this locks down needs no pending create to sweep up after it.
    spawnAgent: () => {
      const child = new PassThrough() as unknown as ChildProcessWithoutNullStreams & { kill(): boolean }
      const stdin = new PassThrough()
      const stdout = new PassThrough()
      stderr = new PassThrough()
      stdin.setEncoding('utf8')
      stdin.on('data', (data: string) => {
        for (const line of data.split('\n').filter(Boolean)) {
          const request = JSON.parse(line) as { id?: number; method?: string }
          const result =
            request.method === 'initialize'
              ? { protocolVersion: 1, agentCapabilities: {}, authMethods: [] }
              : request.method === 'session/new'
                ? { sessionId: 'live-session' }
                : undefined
          if (result !== undefined) stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`)
        }
      })
      Object.assign(child, { stdin, stdout, stderr, kill: () => true })
      return child
    }
  })

  const result = await manager.create({ id: 'node-1', provider: 'claude', cwd: appPath }, owner)
  assert.equal(result.status, 'ready')
  manager.kill('node-1')

  // Await actual delivery: the manager's own 'data' listener runs first (it was attached first).
  const delivered = new Promise((resolve) => stderr?.once('data', resolve))
  stderr?.write('late diagnostic after kill\n')
  await delivered

  assert.equal(broker.snapshot('node-1'), null)
})

test('startPrompt reports delivery immediately and refuses a second prompt while the turn runs', async () => {
  const appPath = mkdtempSync(join(tmpdir(), 'toucan-broker-start-prompt-'))
  promptingAdapter(appPath, {})
  const broker = createAgentEventBroker()
  const owner = { isDestroyed: () => false, send: () => {} } as unknown as WebContents
  const remote: AgentEvent[] = []
  broker.subscribe('node-1', (event) => remote.push(event))
  const manager = createAcpSessionManager({ appPath, broker })

  try {
    await manager.create({ id: 'node-1', provider: 'claude', cwd: appPath }, owner)

    // This adapter parks the turn on an approval, so the turn is provably still open below.
    assert.deepEqual(manager.startPrompt('node-1', 'run the tests'), { ok: true })
    const approval = await until(() =>
      remote.find((event): event is Extract<AgentEvent, { type: 'approval' }> => event.type === 'approval')
    )

    // The busy policy the phone's composer reflects: refused with a reason, never queued here and
    // never steered into the turn in flight.
    assert.deepEqual(manager.startPrompt('node-1', 'and also this'), {
      ok: false,
      message: 'The agent session is busy.'
    })

    manager.resolveApproval('node-1', approval.approvalId, 'allow')
    // The turn's own outcome arrives as events, which is the only channel a remote client has.
    await until(() => remote.find((event) => event.type === 'turn_complete'))
    await until(() => remote.some((event) => event.type === 'status' && event.status === 'idle') || undefined)

    // Idle again, so the same session accepts the next prompt.
    assert.deepEqual(manager.startPrompt('node-1', 'now this'), { ok: true })
  } finally {
    manager.killAll()
  }
})

test('startPrompt refuses a session that does not exist instead of dropping the message', () => {
  const manager = createAcpSessionManager({ appPath: mkdtempSync(join(tmpdir(), 'toucan-broker-no-session-')) })
  assert.deepEqual(manager.startPrompt('nobody', 'hello'), {
    ok: false,
    message: 'The agent session is not ready.'
  })
})

const userMessages = (events: AgentEvent[]): Array<Extract<AgentEvent, { type: 'message' }>> =>
  events.filter(
    (event): event is Extract<AgentEvent, { type: 'message' }> => event.type === 'message' && event.role === 'user'
  )

test('an accepted prompt publishes exactly one host-authored user message to every subscriber and the snapshot', async () => {
  const appPath = mkdtempSync(join(tmpdir(), 'toucan-broker-user-message-'))
  promptingAdapter(appPath, {})
  const broker = createAgentEventBroker()
  const ownerEvents: AgentEvent[] = []
  const owner = {
    isDestroyed: () => false,
    send: (_channel: string, envelope: AgentEventEnvelope) => ownerEvents.push(envelope.event)
  } as unknown as WebContents
  const remote: AgentEvent[] = []
  broker.subscribe('node-1', (event) => remote.push(event))
  const manager = createAcpSessionManager({ appPath, broker })

  try {
    await manager.create({ id: 'node-1', provider: 'claude', cwd: appPath }, owner)
    assert.deepEqual(manager.startPrompt('node-1', 'run the tests'), { ok: true })
    const approval = await until(() => remote.find((event) => event.type === 'approval'))
    assert.ok(approval)

    // A refused prompt is not a message anyone sent, so it publishes nothing.
    assert.equal(manager.startPrompt('node-1', 'and also this').ok, false)

    const published = userMessages(remote)
    assert.equal(published.length, 1)
    assert.equal(published[0].text, 'run the tests')
    assert.ok(published[0].messageId.length > 0)
    assert.deepEqual(userMessages(ownerEvents), published)
    // The message is accepted before the turn is reported as working, so a transcript folded from
    // the stream places it ahead of everything the turn produces.
    assert.ok(
      remote.indexOf(published[0]) < remote.findIndex((event) => event.type === 'status' && event.status === 'working')
    )
    // A late joiner reads it from the snapshot, in transcript position.
    const snapshot = broker.snapshot('node-1')
    assert.deepEqual(
      snapshot?.messages.filter((message) => message.role === 'user').map((message) => message.text),
      ['run the tests']
    )
    assert.deepEqual(snapshot?.transcript[0], { type: 'message', id: published[0].messageId, role: 'user' })
  } finally {
    manager.killAll()
  }
})

test('an adapter that echoes the prompt back live does not make a second user message', async () => {
  const appPath = mkdtempSync(join(tmpdir(), 'toucan-broker-echo-'))
  promptingAdapter(appPath, { echoPrompt: true })
  const broker = createAgentEventBroker()
  const owner = { isDestroyed: () => false, send: () => {} } as unknown as WebContents
  const remote: AgentEvent[] = []
  broker.subscribe('node-1', (event) => remote.push(event))
  const manager = createAcpSessionManager({ appPath, broker })

  try {
    await manager.create({ id: 'node-1', provider: 'claude', cwd: appPath }, owner)
    const turn = manager.prompt('node-1', 'run the tests')
    const approval = await until(() =>
      remote.find((event): event is Extract<AgentEvent, { type: 'approval' }> => event.type === 'approval')
    )
    manager.resolveApproval('node-1', approval.approvalId, 'allow')
    await turn

    assert.deepEqual(
      userMessages(remote).map((message) => message.text),
      ['run the tests']
    )
    assert.equal(broker.snapshot('node-1')?.messages.filter((message) => message.role === 'user').length, 1)
  } finally {
    manager.killAll()
  }
})

test('a follow-up steered into a working turn is published as a user message when the adapter accepts it', async () => {
  const appPath = mkdtempSync(join(tmpdir(), 'toucan-broker-steered-'))
  promptingAdapter(appPath, { steering: true })
  const broker = createAgentEventBroker()
  const owner = { isDestroyed: () => false, send: () => {} } as unknown as WebContents
  const remote: AgentEvent[] = []
  broker.subscribe('node-1', (event) => remote.push(event))
  const manager = createAcpSessionManager({ appPath, broker })

  try {
    await manager.create({ id: 'node-1', provider: 'claude', cwd: appPath }, owner)
    const turn = manager.prompt('node-1', 'run the tests')
    const approval = await until(() =>
      remote.find((event): event is Extract<AgentEvent, { type: 'approval' }> => event.type === 'approval')
    )
    assert.deepEqual(await manager.promptWhenIdle('node-1', 'and also lint'), { ok: true })
    manager.resolveApproval('node-1', approval.approvalId, 'allow')
    await turn

    assert.deepEqual(
      userMessages(remote).map((message) => message.text),
      ['run the tests', 'and also lint']
    )
    const [first, second] = userMessages(remote)
    assert.notEqual(first.messageId, second.messageId)
  } finally {
    manager.killAll()
  }
})

import { strict as assert } from 'node:assert'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import type { WebContents } from 'electron'
import { createAcpSessionManager, startingProgressFrom } from '../src/main/acp-session-manager'
import { createAgentEventBroker } from '../src/main/agent-event-broker'
import type { SessionOutcomeContext } from '../src/main/session-outcome-indexer'
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

/**
 * An adapter whose prompt turn parks on a form elicitation instead of a permission request, so a
 * structured question set can be answered against a real session rather than a stub.
 */
function elicitingAdapter(appPath: string): void {
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
    send({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } })
  } else if (request.method === 'session/new') {
    send({ jsonrpc: '2.0', id: request.id, result: { sessionId: 'live-session' } })
  } else if (request.method === 'session/prompt') {
    pendingPrompt = request.id
    send({ jsonrpc: '2.0', id: 901, method: 'elicitation/create', params: {
      mode: 'form',
      sessionId: request.params.sessionId,
      message: 'Please answer the following questions.',
      requestedSchema: {
        type: 'object',
        required: ['scope'],
        properties: {
          scope: {
            type: 'string',
            title: 'Scope',
            description: 'Read-only first?',
            oneOf: [{ const: 'Read-only', title: 'Read-only' }, { const: 'Complete CRUD', title: 'Complete CRUD' }]
          }
        }
      }
    } })
  } else if (request.method === undefined && request.id === 901) {
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

/**
 * An in-process adapter that completes the handshake (so a session is fully established without a
 * child process) and whose stderr the test drives. Optionally logs a diagnostic line while still
 * answering `initialize`, the way a real adapter reports progress during its handshake.
 */
function stderrControlledAdapter(behaviour: { handshakeDiagnostic?: string }): {
  spawnAgent: () => ChildProcessWithoutNullStreams
  stderr: () => PassThrough | undefined
} {
  let stderr: PassThrough | undefined
  return {
    stderr: () => stderr,
    spawnAgent: () => {
      const child = new PassThrough() as unknown as ChildProcessWithoutNullStreams & { kill(): boolean }
      const stdin = new PassThrough()
      const stdout = new PassThrough()
      stderr = new PassThrough()
      stdin.setEncoding('utf8')
      stdin.on('data', (data: string) => {
        for (const line of data.split('\n').filter(Boolean)) {
          const request = JSON.parse(line) as { id?: number; method?: string }
          if (request.method === 'initialize' && behaviour.handshakeDiagnostic) {
            stderr?.write(`${behaviour.handshakeDiagnostic}\n`)
          }
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
  }
}

test("a killed adapter's straggling stderr cannot resurrect the closed broker channel", async () => {
  const appPath = mkdtempSync(join(tmpdir(), 'toucan-broker-straggler-'))
  promptingAdapter(appPath, {})
  const broker = createAgentEventBroker()
  const owner = { isDestroyed: () => false, send: () => {} } as unknown as WebContents
  // The session is fully established before the kill: the leak this locks down needs no pending
  // create to sweep up after it.
  const adapter = stderrControlledAdapter({})
  const manager = createAcpSessionManager({ appPath, broker, spawnAgent: adapter.spawnAgent })

  const result = await manager.create({ id: 'node-1', provider: 'claude', cwd: appPath }, owner)
  assert.equal(result.status, 'ready')
  manager.kill('node-1')

  // Await actual delivery: the manager's own 'data' listener runs first (it was attached first).
  const delivered = new Promise((resolve) => adapter.stderr()?.once('data', resolve))
  adapter.stderr()?.write('late diagnostic after kill\n')
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

/**
 * Answering the same request from two clients at once - the desktop and a phone - is the race the
 * remote surface makes possible, so the pending-request map is where it has to be decided. Both
 * cases below assert the same three things: exactly one answer reaches the provider, the loser is
 * told why, and every subscriber sees one resolution.
 */
test('two clients answering one approval: the first wins, the second is refused, the provider hears one answer', async () => {
  const appPath = mkdtempSync(join(tmpdir(), 'toucan-broker-approval-race-'))
  promptingAdapter(appPath, {})
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

    assert.deepEqual(manager.resolveApproval('node-1', approval.approvalId, 'allow'), { ok: true })
    // The second device answering the card it was still showing. Refused, not sent twice.
    const loser = manager.resolveApproval('node-1', approval.approvalId, 'reject')
    assert.equal(loser.ok, false)
    assert.match(loser.message ?? '', /already answered/)

    assert.equal((await turn).ok, true)
    // One resolution reaches every subscriber, so the loser's card retires from the same source.
    assert.equal(remote.filter((event) => event.type === 'approval_resolved').length, 1)
    assert.equal(broker.snapshot('node-1')?.approval, null)
  } finally {
    manager.killAll()
  }
})

test('two clients answering one structured question set: one answer reaches the agent', async () => {
  const appPath = mkdtempSync(join(tmpdir(), 'toucan-broker-decision-race-'))
  elicitingAdapter(appPath)
  const broker = createAgentEventBroker()
  const owner = { isDestroyed: () => false, send: () => {} } as unknown as WebContents
  const remote: AgentEvent[] = []
  broker.subscribe('node-1', (event) => remote.push(event))
  const manager = createAcpSessionManager({ appPath, broker })

  try {
    await manager.create({ id: 'node-1', provider: 'claude', cwd: appPath }, owner)
    const turn = manager.prompt('node-1', 'ask me')
    const request = await until(() =>
      remote.find(
        (event): event is Extract<AgentEvent, { type: 'decision_request' }> => event.type === 'decision_request'
      )
    )
    assert.deepEqual(
      broker.snapshot('node-1')?.decisionRequests.map((pending) => pending.id),
      [request.request.id]
    )

    assert.deepEqual(manager.resolveElicitation('node-1', request.request.id, { scope: 'Read-only' }), { ok: true })
    const loser = manager.resolveElicitation('node-1', request.request.id, { scope: 'Complete CRUD' })
    assert.equal(loser.ok, false)
    assert.match(loser.message ?? '', /already answered/)

    assert.equal((await turn).ok, true)
    assert.equal(remote.filter((event) => event.type === 'decision_resolved').length, 1)
    assert.deepEqual(broker.snapshot('node-1')?.decisionRequests, [])
  } finally {
    manager.killAll()
  }
})

test('answering a request on a session that is not running is refused rather than ignored', () => {
  const manager = createAcpSessionManager({ appPath: mkdtempSync(join(tmpdir(), 'toucan-broker-absent-')) })
  assert.match(manager.resolveApproval('nope', 'approval-1', 'allow').message ?? '', /not running/)
  assert.match(manager.resolveElicitation('nope', 'request-1').message ?? '', /not running/)
})

test('adapter stderr arriving after the session is ready cannot regress its status to starting (#158)', async () => {
  const appPath = mkdtempSync(join(tmpdir(), 'toucan-broker-late-stderr-'))
  promptingAdapter(appPath, {})
  const broker = createAgentEventBroker()
  const delivered: AgentEvent[] = []
  const owner = {
    isDestroyed: () => false,
    send: (_channel: string, envelope: AgentEventEnvelope) => delivered.push(envelope.event)
  } as unknown as WebContents
  const adapter = stderrControlledAdapter({})
  const manager = createAcpSessionManager({ appPath, broker, spawnAgent: adapter.spawnAgent })

  try {
    const result = await manager.create({ id: 'node-1', provider: 'claude', cwd: appPath }, owner)
    assert.equal(result.status, 'ready')
    const before = delivered.length

    // stderr and stdout are separate pipes: the adapter's `[session/load]` timing log routinely
    // lands after the `session/load` response that made the session ready.
    const received = new Promise((resolve) => adapter.stderr()?.once('data', resolve))
    adapter.stderr()?.write('[session/load] sessionId=abc phase=replay durationMs=1596 totalMs=1596\n')
    await received

    assert.equal(broker.snapshot('node-1')?.status, 'ready')
    assert.deepEqual(
      delivered.slice(before).filter((event) => event.type === 'status'),
      [],
      'a late diagnostic must not be published as a status change'
    )
  } finally {
    manager.killAll()
  }
})

test('adapter stderr during the handshake still surfaces as starting progress', async () => {
  const appPath = mkdtempSync(join(tmpdir(), 'toucan-broker-handshake-stderr-'))
  promptingAdapter(appPath, {})
  const broker = createAgentEventBroker()
  const delivered: AgentEvent[] = []
  const owner = {
    isDestroyed: () => false,
    send: (_channel: string, envelope: AgentEventEnvelope) => delivered.push(envelope.event)
  } as unknown as WebContents
  const adapter = stderrControlledAdapter({ handshakeDiagnostic: 'Loading provider credentials...' })
  const manager = createAcpSessionManager({ appPath, broker, spawnAgent: adapter.spawnAgent })

  try {
    const result = await manager.create({ id: 'node-1', provider: 'claude', cwd: appPath }, owner)
    assert.equal(result.status, 'ready')
    assert.ok(
      delivered.some(
        (event) =>
          event.type === 'status' && event.status === 'starting' && event.message === 'Loading provider credentials...'
      ),
      'handshake diagnostics are the only progress a user sees while the session opens'
    )
    assert.equal(broker.snapshot('node-1')?.status, 'ready')
  } finally {
    manager.killAll()
  }
})

test("the adapter's advisory claude auth status diagnostics never reach the node as progress", async () => {
  const appPath = mkdtempSync(join(tmpdir(), 'toucan-broker-auth-probe-stderr-'))
  promptingAdapter(appPath, {})
  const broker = createAgentEventBroker()
  const delivered: AgentEvent[] = []
  const owner = {
    isDestroyed: () => false,
    send: (_channel: string, envelope: AgentEventEnvelope) => delivered.push(envelope.event)
  } as unknown as WebContents
  const adapter = stderrControlledAdapter({ handshakeDiagnostic: 'claude auth status returned unparseable output' })
  const manager = createAcpSessionManager({ appPath, broker, spawnAgent: adapter.spawnAgent })

  try {
    const result = await manager.create({ id: 'node-1', provider: 'claude', cwd: appPath }, owner)
    assert.equal(result.status, 'ready')
    assert.ok(
      !delivered.some((event) => event.type === 'status' && (event.message ?? '').includes('claude auth status')),
      'a failed auth probe changes nothing on screen, so it must not be published as a hint'
    )
  } finally {
    manager.killAll()
  }
})

test('a stderr chunk keeps the lines around an ignored diagnostic', () => {
  assert.equal(
    startingProgressFrom('claude auth status returned unparseable output\nLoading provider credentials...'),
    'Loading provider credentials...'
  )
  assert.equal(startingProgressFrom('claude auth status failed: ENOENT\n'), undefined)
  assert.equal(startingProgressFrom('   \n'), undefined)
})

test('the session outcome index is handed each session with the live conversation id', async () => {
  const appPath = mkdtempSync(join(tmpdir(), 'toucan-broker-outcomes-'))
  promptingAdapter(appPath, {})
  const broker = createAgentEventBroker()
  const owner = { isDestroyed: () => false, send: () => {} } as unknown as WebContents
  const watched: { sessionId: string; context: () => SessionOutcomeContext | null }[] = []
  const manager = createAcpSessionManager({
    appPath,
    broker,
    sessionOutcomes: {
      watch: (sessionId, context) => {
        watched.push({ sessionId, context })
        return { idle: () => Promise.resolve(), recordWrites: () => {}, finalize: () => {} }
      }
    }
  })

  try {
    await manager.create({ id: 'node-1', provider: 'claude', cwd: appPath }, owner)

    assert.equal(watched.length, 1)
    assert.equal(watched[0].sessionId, 'node-1')
    // Read at the boundary rather than captured at create: the provider names the conversation
    // only once the session has opened.
    assert.deepEqual(watched[0].context(), {
      provider: 'claude',
      conversationId: 'live-session',
      projectPath: appPath
    })
  } finally {
    manager.killAll()
  }

  // Closing the session retires the index's subscription with every other one.
  assert.equal(broker.snapshot('node-1'), null)
  assert.equal(watched[0].context(), null)
})

/** An adapter whose turn reports one file edit and one file read, then finishes. */
function toolCallingAdapter(appPath: string): void {
  const directory = join(appPath, 'node_modules', '@agentclientprotocol', 'claude-agent-acp', 'dist')
  mkdirSync(directory, { recursive: true })
  writeFileSync(
    join(directory, 'index.js'),
    `
const readline = require('node:readline')
const lines = readline.createInterface({ input: process.stdin })
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n')
lines.on('line', (line) => {
  const request = JSON.parse(line)
  if (request.method === 'initialize') {
    send({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } })
  } else if (request.method === 'session/new') {
    send({ jsonrpc: '2.0', id: request.id, result: { sessionId: 'live-session' } })
  } else if (request.method === 'session/prompt') {
    const update = (u) => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: request.params.sessionId, update: u } })
    update({ sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'Edit', kind: 'edit', locations: [{ path: 'src/a.ts' }] })
    update({ sessionUpdate: 'tool_call', toolCallId: 'c2', title: 'Read', kind: 'read', locations: [{ path: 'src/b.ts' }] })
    update({ sessionUpdate: 'tool_call', toolCallId: 'c3', title: 'Search', kind: 'search', locations: [{ path: 'src/c.ts' }] })
    send({ jsonrpc: '2.0', id: request.id, result: { stopReason: 'end_turn' } })
  }
})
`,
    'utf8'
  )
}

test('only file-writing tool calls reach the outcome index', async () => {
  const appPath = mkdtempSync(join(tmpdir(), 'toucan-broker-writes-'))
  toolCallingAdapter(appPath)
  const owner = { isDestroyed: () => false, send: () => {} } as unknown as WebContents
  const written: string[] = []
  let finalized = 0
  const manager = createAcpSessionManager({
    appPath,
    sessionOutcomes: {
      watch: () => ({
        idle: () => Promise.resolve(),
        recordWrites: (paths) => {
          written.push(...paths)
        },
        finalize: () => {
          finalized += 1
        }
      })
    }
  })

  try {
    await manager.create({ id: 'node-1', provider: 'claude', cwd: appPath }, owner)
    await manager.prompt('node-1', 'Edit one file and read two others.')

    // `src/b.ts` was read and `src/c.ts` searched: having looked at a file is not having written it.
    assert.deepEqual(written, [join(appPath, 'src', 'a.ts')])
  } finally {
    manager.killAll()
  }

  // The adapter process exiting retires no broker channel, so its own exit is the only thing that
  // can tell the index this session is over.
  await until(() => finalized > 0)
})

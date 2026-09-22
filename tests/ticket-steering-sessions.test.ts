import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'
import type { WebContents } from 'electron'
import { createAcpSessionManager } from '../src/main/acp-session-manager'
import { createTicketLibrary } from '../src/main/ticket-library'
import { createTicketSteering } from '../src/main/ticket-steering'
import type { AgentEvent, AgentEventEnvelope } from '../src/shared/agent'
import type { AgentProvider } from '../src/shared/agent-provider'

/**
 * The whole loop against a live ACP session: an agent writes a file the ticket board cannot show,
 * Toucan notices through the same listing the board renders, and the agent hears about it - steered
 * into the open turn where the adapter supports that, queued as the next prompt where it does not.
 *
 * What is proved here and nowhere else is the attribution evidence itself: tool-call `locations`
 * survive the adapter boundary, resolve against the session's own working directory, and count
 * only when the call actually changed the file.
 */

/**
 * An adapter that reports two writes and one read during a turn it then parks on an approval, and
 * echoes any follow-up it is given back as assistant text so the test can read what it received.
 */
function writingAdapter(appPath: string, provider: AgentProvider, steering: boolean): void {
  const module = provider === 'codex' ? 'codex-acp' : 'claude-agent-acp'
  const directory = join(appPath, 'node_modules', '@agentclientprotocol', module, 'dist')
  mkdirSync(directory, { recursive: true })
  writeFileSync(
    join(directory, 'index.js'),
    `
const readline = require('node:readline')
const lines = readline.createInterface({ input: process.stdin })
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n')
const echo = (text) => send({ jsonrpc: '2.0', method: 'session/update', params: {
  sessionId: 'live-session',
  update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'RECEIVED:' + text } }
} })
const textOf = (prompt) => prompt.map((block) => block.text || '').join('')
let pendingPrompt
let turns = 0
lines.on('line', (line) => {
  const request = JSON.parse(line)
  if (request.method === 'initialize') {
    send({ jsonrpc: '2.0', id: request.id, result: {
      protocolVersion: 1,
      agentCapabilities: {},
      authMethods: [],
      ${steering ? '_meta: { steering: { supported: true } },' : ''}
    } })
  } else if (request.method === 'session/new') {
    send({ jsonrpc: '2.0', id: request.id, result: { sessionId: 'live-session' } })
  } else if (request.method === 'session/prompt') {
    pendingPrompt = request.id
    turns += 1
    if (turns > 1) {
      echo(textOf(request.params.prompt))
      send({ jsonrpc: '2.0', id: request.id, result: { stopReason: 'end_turn' } })
      return
    }
    // Relative on purpose: an adapter reports what its tool reported, and only the session knows
    // which checkout that was relative to.
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'live-session', update: {
      sessionUpdate: 'tool_call', toolCallId: 'call-write', title: 'Write', kind: 'edit',
      status: 'completed', locations: [{ path: 'docs/tickets/To Tickets.md' }]
    } } })
    // A second write, of a file the board is perfectly happy to render: the session must not be
    // corrected over it, which is the whole difference the lenient board makes here.
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'live-session', update: {
      sessionUpdate: 'tool_call', toolCallId: 'call-note', title: 'Write', kind: 'edit',
      status: 'completed', locations: [{ path: 'docs/tickets/hand-written.md' }]
    } } })
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'live-session', update: {
      sessionUpdate: 'tool_call', toolCallId: 'call-read', title: 'Read', kind: 'read',
      status: 'completed', locations: [{ path: 'docs/tickets/Stray Notes.md' }]
    } } })
    send({ jsonrpc: '2.0', id: 900, method: 'session/request_permission', params: {
      sessionId: 'live-session',
      toolCall: { toolCallId: 'call-approve', title: 'Run npm test', kind: 'execute' },
      options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }]
    } })
  } else if (request.method === '_session/steering') {
    echo(textOf(request.params.prompt))
    send({ jsonrpc: '2.0', id: request.id, result: { outcome: 'injected' } })
  } else if (request.method === undefined && request.id === 900) {
    send({ jsonrpc: '2.0', id: pendingPrompt, result: { stopReason: 'end_turn' } })
  }
})
`,
    'utf8'
  )
}

function malformedTickets(projectPath: string): void {
  const folder = join(projectPath, 'docs', 'tickets')
  mkdirSync(folder, { recursive: true })
  // Both unshowable for the one reason left: their names are not ids. Their contents are fine.
  writeFileSync(join(folder, 'To Tickets.md'), '# Convert the board\n\nNo frontmatter at all.\n', 'utf8')
  writeFileSync(join(folder, 'Stray Notes.md'), '# Someone else’s notes\n', 'utf8')
  // Named like a ticket, written like a note: a card, and so never anything to steer anyone over.
  writeFileSync(join(folder, 'hand-written.md'), '# Look into the flaky test\n', 'utf8')
}

async function until<T>(get: () => T | undefined): Promise<T> {
  for (let attempt = 0; attempt < 400; attempt++) {
    const value = get()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('condition not reached')
}

function harness(appPath: string): {
  manager: ReturnType<typeof createAcpSessionManager>
  steering: ReturnType<typeof createTicketSteering>
  events: AgentEvent[]
  owner: WebContents
} {
  const events: AgentEvent[] = []
  const owner = {
    isDestroyed: () => false,
    send: (_channel: string, envelope: AgentEventEnvelope) => events.push(envelope.event)
  } as unknown as WebContents
  const manager = createAcpSessionManager({ appPath })
  const library = createTicketLibrary({
    directoryFor: (projectPath) => join(projectPath, 'docs', 'tickets'),
    today: () => '2026-01-01'
  })
  const steering = createTicketSteering({
    diagnosticsFor: async (projectPath) => (await library.list(projectPath)).diagnostics,
    recentWrites: () => manager.recentWrites(),
    steer: (agentId, text) => manager.promptWhenIdle(agentId, text)
  })
  return { manager, steering, events, owner }
}

const received = (events: AgentEvent[]): string | undefined =>
  events.find(
    (event): event is Extract<AgentEvent, { type: 'message' }> =>
      event.type === 'message' && event.text.startsWith('RECEIVED:')
  )?.text

test('a session that wrote an unreadable ticket is steered mid-turn, naming only the file it wrote', async () => {
  const appPath = mkdtempSync(join(tmpdir(), 'toucan-ticket-steer-claude-'))
  writingAdapter(appPath, 'claude', true)
  malformedTickets(appPath)
  const { manager, steering, events, owner } = harness(appPath)

  try {
    await manager.create({ id: 'node-1', provider: 'claude', cwd: appPath }, owner)
    const turn = manager.prompt('node-1', 'file the tickets')
    // Both writes are attributed; the read of the other unshowable file deliberately is not.
    await until(() => manager.recentWrites().length > 1)
    assert.deepEqual(
      manager.recentWrites().map((write) => write.agentId),
      ['node-1', 'node-1']
    )

    await steering.check(appPath)
    const message = await until(() => received(events))

    assert.ok(message.includes(join(appPath, 'docs', 'tickets', 'To Tickets.md')))
    assert.ok(!message.includes('Stray Notes.md'))
    // The note it also wrote is a card, so it is not in the message however recently it was written.
    assert.ok(!message.includes('hand-written.md'))
    assert.ok(message.includes('`<lowercase-kebab-case>.md`'))

    const approval = events.find((event) => event.type === 'approval')
    assert.ok(approval && approval.type === 'approval')
    manager.resolveApproval('node-1', approval.approvalId, 'allow')
    await turn
  } finally {
    manager.killAll()
  }
})

test('a Codex session, whose adapter cannot steer, receives the same message as its next prompt', async () => {
  const appPath = mkdtempSync(join(tmpdir(), 'toucan-ticket-steer-codex-'))
  writingAdapter(appPath, 'codex', false)
  malformedTickets(appPath)
  const { manager, steering, events, owner } = harness(appPath)

  try {
    await manager.create({ id: 'node-1', provider: 'codex', cwd: appPath }, owner)
    const turn = manager.prompt('node-1', 'file the tickets')
    await until(() => manager.recentWrites().length > 0)

    await steering.check(appPath)
    // Queued rather than injected: nothing reaches the adapter while its turn is still open.
    assert.equal(received(events), undefined)

    const approval = events.find((event) => event.type === 'approval')
    assert.ok(approval && approval.type === 'approval')
    manager.resolveApproval('node-1', approval.approvalId, 'allow')
    await turn

    const message = await until(() => received(events))
    assert.ok(message.includes(join(appPath, 'docs', 'tickets', 'To Tickets.md')))
  } finally {
    manager.killAll()
  }
})

test('two sessions in one checkout: only the one that wrote the file is steered', async () => {
  const appPath = mkdtempSync(join(tmpdir(), 'toucan-ticket-steer-two-'))
  writingAdapter(appPath, 'claude', true)
  malformedTickets(appPath)
  const { manager, steering, events, owner } = harness(appPath)
  const idleEvents: AgentEvent[] = []
  const idleOwner = {
    isDestroyed: () => false,
    send: (_channel: string, envelope: AgentEventEnvelope) => idleEvents.push(envelope.event)
  } as unknown as WebContents

  try {
    await manager.create({ id: 'node-1', provider: 'claude', cwd: appPath }, owner)
    await manager.create({ id: 'node-2', provider: 'claude', cwd: appPath }, idleOwner)
    const turn = manager.prompt('node-1', 'file the tickets')
    await until(() => manager.recentWrites().length > 0)

    await steering.check(appPath)
    await until(() => received(events))

    // node-2 ran nothing: a session sharing the checkout is not a suspect.
    assert.equal(received(idleEvents), undefined)

    const approval = events.find((event) => event.type === 'approval')
    assert.ok(approval && approval.type === 'approval')
    manager.resolveApproval('node-1', approval.approvalId, 'allow')
    await turn
  } finally {
    manager.killAll()
  }
})

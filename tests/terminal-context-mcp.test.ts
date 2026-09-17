import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  createTerminalContextMcp,
  renderTerminalRead,
  READ_TERMINAL_OUTPUT_TOOL,
  TERMINAL_CONTEXT_MCP_SERVER_NAME,
  type AcpMcpHttpServer,
  type TerminalContextMcp
} from '../src/main/terminal-context-mcp'
import { createTerminalContextRegistry } from '../src/main/terminal-context-registry'
import type { TerminalOutputRead, TerminalReadOptions } from '../src/main/terminal-output-tail'

// Slice 3 of docs/plans/terminal-context-edge.md: the MCP server behind the terminal-context
// edge. These tests drive it exactly the way an adapter's MCP client does - plain JSON-RPC POSTs
// against the localhost listener - so the wire behaviour both pinned adapters rely on is pinned
// here, not only the tool logic.

interface Harness {
  mcp: TerminalContextMcp
  registry: ReturnType<typeof createTerminalContextRegistry>
  reads: Array<{ agentId: string; terminalSessionId: string; options?: TerminalReadOptions }>
  read: TerminalOutputRead | undefined
}

function harness(read?: TerminalOutputRead): Harness {
  const registry = createTerminalContextRegistry()
  const state: Harness = {
    registry,
    reads: [],
    read,
    mcp: undefined as unknown as TerminalContextMcp
  }
  state.mcp = createTerminalContextMcp({
    registry,
    readOutput: (agentId, terminalSessionId, options) => {
      state.reads.push({ agentId, terminalSessionId, options })
      return state.read
    }
  })
  return state
}

const outputRead = (overrides: Partial<TerminalOutputRead> = {}): TerminalOutputRead => ({
  terminalSessionId: 'shell-1',
  incarnationId: 'incarnation-1',
  liveness: 'live',
  text: 'compiled successfully\n',
  delta: false,
  skippedBytes: 0,
  ...overrides
})

async function rpc(
  server: AcpMcpHttpServer,
  message: unknown,
  token = server.headers[0]?.value.replace(/^Bearer /, '')
): Promise<{ status: number; body?: { result?: Record<string, unknown>; error?: { code: number } } }> {
  const response = await fetch(server.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify(message)
  })
  const text = await response.text()
  return { status: response.status, ...(text ? { body: JSON.parse(text) } : {}) }
}

function toolResultText(body?: { result?: Record<string, unknown> }): { text: string; isError: boolean } {
  const result = body?.result as { content: Array<{ type: string; text: string }>; isError?: boolean } | undefined
  assert.ok(result, 'tools/call returned a result')
  return { text: result.content[0]?.text ?? '', isError: result.isError === true }
}

const callRead = (args: Record<string, unknown> = {}): unknown => ({
  jsonrpc: '2.0',
  id: 1,
  method: 'tools/call',
  params: { name: READ_TERMINAL_OUTPUT_TOOL.name, arguments: args }
})

test('no edge means no server entry and no listener at all', async (t) => {
  const { mcp, registry } = harness()
  t.after(() => void mcp.close())
  registry.replaceEdges([])
  assert.equal(await mcp.serverFor('agent-1'), undefined)
  // The >90% case pays nothing: no tokens in the session, and no port bound on the machine.
  assert.equal(mcp.listening(), false)
})

test('an edge yields an HTTP entry whose bearer token identifies the agent', async (t) => {
  const { mcp, registry } = harness(outputRead())
  t.after(() => void mcp.close())
  registry.replaceEdges([
    { terminalSessionId: 'shell-1', agentId: 'agent-1' },
    { terminalSessionId: 'shell-2', agentId: 'agent-2' }
  ])

  const first = await mcp.serverFor('agent-1')
  const second = await mcp.serverFor('agent-2')
  assert.ok(first && second)
  assert.equal(first.name, TERMINAL_CONTEXT_MCP_SERVER_NAME)
  assert.equal(first.type, 'http')
  assert.match(first.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/)
  assert.match(first.headers[0]!.value, /^Bearer \S+$/)
  // Distinct tokens: the token is what names the calling agent, so two agents can never share one.
  assert.notEqual(first.headers[0]!.value, second.headers[0]!.value)
  // Stable per agent: a session resume reuses the grant rather than growing the token map.
  assert.equal((await mcp.serverFor('agent-1'))?.headers[0]!.value, first.headers[0]!.value)
})

test('speaks enough MCP for both adapters: initialize, notifications, tools/list, ping', async (t) => {
  const { mcp, registry } = harness(outputRead())
  t.after(() => void mcp.close())
  registry.replaceEdges([{ terminalSessionId: 'shell-1', agentId: 'agent-1' }])
  const server = (await mcp.serverFor('agent-1'))!

  const initialized = await rpc(server, {
    jsonrpc: '2.0',
    id: 0,
    method: 'initialize',
    params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '0' } }
  })
  assert.equal(initialized.status, 200)
  // A known revision is echoed back rather than forcing the newest on an older client.
  assert.equal(initialized.body?.result?.protocolVersion, '2025-03-26')
  assert.deepEqual(initialized.body?.result?.capabilities, { tools: {} })

  // Notifications get 202 and no body - a response to one would be a protocol violation.
  const notified = await rpc(server, { jsonrpc: '2.0', method: 'notifications/initialized' })
  assert.equal(notified.status, 202)

  const listed = await rpc(server, { jsonrpc: '2.0', id: 1, method: 'tools/list' })
  const tools = listed.body?.result?.tools as Array<{ name: string }>
  assert.deepEqual(
    tools.map((tool) => tool.name),
    [READ_TERMINAL_OUTPUT_TOOL.name]
  )

  const pinged = await rpc(server, { jsonrpc: '2.0', id: 2, method: 'ping' })
  assert.deepEqual(pinged.body?.result, {})

  const unknown = await rpc(server, { jsonrpc: '2.0', id: 3, method: 'resources/list' })
  assert.equal(unknown.body?.error?.code, -32601)
})

test('a token is the whole authorization story: absent, wrong, or non-POST is refused', async (t) => {
  const { mcp, registry } = harness(outputRead())
  t.after(() => void mcp.close())
  registry.replaceEdges([{ terminalSessionId: 'shell-1', agentId: 'agent-1' }])
  const server = (await mcp.serverFor('agent-1'))!

  assert.equal((await rpc(server, callRead(), '')).status, 401)
  assert.equal((await rpc(server, callRead(), 'not-the-token')).status, 401)
  const got = await fetch(server.url, {
    method: 'GET',
    headers: { authorization: server.headers[0]!.value }
  })
  assert.equal(got.status, 405)
})

test('a read serves the tail, labelled with liveness and reach, through the caller identity', async (t) => {
  const state = harness(outputRead())
  t.after(() => void state.mcp.close())
  state.registry.replaceEdges([{ terminalSessionId: 'shell-1', agentId: 'agent-1' }])
  const server = (await state.mcp.serverFor('agent-1'))!

  const result = toolResultText((await rpc(server, callRead())).body)
  assert.equal(result.isError, false)
  assert.equal(result.text, '[terminal shell-1 | process running | most recent output]\ncompiled successfully\n')
  // The cursor is per reader, so the read must be keyed by the *token's* agent, never a parameter.
  assert.deepEqual(state.reads, [
    { agentId: 'agent-1', terminalSessionId: 'shell-1', options: { maxBytes: undefined, maxLines: undefined } }
  ])

  state.read = outputRead({ liveness: 'exited', delta: true, text: '', skippedBytes: 0 })
  const empty = toolResultText((await rpc(server, callRead({ maxLines: 50, maxBytes: 2048 }))).body)
  assert.equal(
    empty.text,
    '[terminal shell-1 | process exited | output since your last read]\n(no new output since your last read)'
  )
  assert.deepEqual(state.reads[1]?.options, { maxBytes: 2048, maxLines: 50 })

  state.read = outputRead({ delta: true, skippedBytes: 300, text: 'tail\n' })
  const skipped = toolResultText((await rpc(server, callRead())).body)
  assert.match(skipped.text, /300 bytes skipped/)
})

test('the tool definition grants nothing: a revoked edge refuses at call time', async (t) => {
  const state = harness(outputRead())
  t.after(() => void state.mcp.close())
  state.registry.replaceEdges([{ terminalSessionId: 'shell-1', agentId: 'agent-1' }])
  const server = (await state.mcp.serverFor('agent-1'))!

  state.registry.replaceEdges([])
  const refused = toolResultText((await rpc(server, callRead())).body)
  assert.equal(refused.isError, true)
  assert.match(refused.text, /No terminal is connected/)
  assert.equal(state.reads.length, 0)
})

test('several terminals need a selector, and only the agent’s own terminals are selectable', async (t) => {
  const state = harness(outputRead({ terminalSessionId: 'shell-2' }))
  t.after(() => void state.mcp.close())
  state.registry.replaceEdges([
    { terminalSessionId: 'shell-1', agentId: 'agent-1' },
    { terminalSessionId: 'shell-2', agentId: 'agent-1' },
    { terminalSessionId: 'shell-3', agentId: 'agent-2' }
  ])
  const server = (await state.mcp.serverFor('agent-1'))!

  // No selector with two edges: the connected set is the answer, not a guess between them.
  const ambiguous = toolResultText((await rpc(server, callRead())).body)
  assert.equal(ambiguous.isError, true)
  assert.match(ambiguous.text, /shell-1, shell-2/)

  const chosen = toolResultText((await rpc(server, callRead({ terminal: 'shell-2' }))).body)
  assert.equal(chosen.isError, false)
  assert.deepEqual(state.reads[0]?.terminalSessionId, 'shell-2')

  // Another agent's terminal is named like any other unconnected one - never readable.
  const foreign = toolResultText((await rpc(server, callRead({ terminal: 'shell-3' }))).body)
  assert.equal(foreign.isError, true)
  assert.match(foreign.text, /No terminal shell-3/)
})

test('a terminal with no tail is an actionable refusal, not a protocol error', async (t) => {
  const state = harness(undefined)
  t.after(() => void state.mcp.close())
  state.registry.replaceEdges([{ terminalSessionId: 'shell-1', agentId: 'agent-1' }])
  const server = (await state.mcp.serverFor('agent-1'))!

  const missing = toolResultText((await rpc(server, callRead())).body)
  assert.equal(missing.isError, true)
  assert.match(missing.text, /no readable output/)
})

test('renderTerminalRead pins the plain-text shape a model is handed', () => {
  assert.equal(
    renderTerminalRead(outputRead({ liveness: 'unverifiable', delta: false, text: '' })),
    '[terminal shell-1 | process state unknown | most recent output]\n(no output)'
  )
})

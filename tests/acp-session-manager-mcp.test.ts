import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { WebContents } from 'electron'
import { createAcpSessionManager } from '../src/main/acp-session-manager'
import type { AcpMcpHttpServer } from '../src/main/terminal-context-mcp'
import { installScriptedAdapter } from './helpers/scripted-adapter'

// Slice 3 of docs/plans/terminal-context-edge.md: the terminal-context MCP server rides
// `mcpServers` on both `session/new` and `session/load`, and only for a session whose chat node
// has a terminal edge at creation - every other session carries zero extra tokens.

function recordingAdapter(appPath: string): string {
  const recordPath = join(appPath, 'requests.json')
  installScriptedAdapter(appPath, 'codex-acp', {
    prelude: `
const fs = require('node:fs')
const record = (request) => fs.appendFileSync(${JSON.stringify(recordPath)}, JSON.stringify({ method: request.method, params: request.params }) + '\\n')`,
    handleRequest: `
  if (request.method === 'session/new') {
    record(request)
    send({ jsonrpc: '2.0', id: request.id, result: { sessionId: 'fresh-session' } })
  } else if (request.method === 'session/load') {
    record(request)
    send({ jsonrpc: '2.0', id: request.id, result: {} })
  }`
  })
  return recordPath
}

interface RecordedRequest {
  method: string
  params: { mcpServers?: AcpMcpHttpServer[] }
}

function recordedRequests(recordPath: string): RecordedRequest[] {
  return readFileSync(recordPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as RecordedRequest)
}

const owner = { isDestroyed: () => false, send: () => {} } as unknown as WebContents

const server: AcpMcpHttpServer = {
  name: 'toucan-terminal',
  type: 'http',
  url: 'http://127.0.0.1:65530/mcp',
  headers: [{ name: 'Authorization', value: 'Bearer token-1' }]
}

test('the terminal-context server rides mcpServers only for a session with an edge', async () => {
  const appPath = mkdtempSync(join(tmpdir(), 'toucan-acp-mcp-'))
  const recordPath = recordingAdapter(appPath)
  const manager = createAcpSessionManager({
    appPath,
    environment: { PATH: process.env.PATH },
    // The seam the real registry-backed server answers: an entry when an edge stands, else nothing.
    terminalContext: { serverFor: async (agentId) => (agentId.startsWith('edged') ? server : undefined) }
  })
  try {
    const edged = await manager.create({ id: 'edged', provider: 'codex', cwd: appPath }, owner)
    const plain = await manager.create({ id: 'plain', provider: 'codex', cwd: appPath }, owner)
    const resumed = await manager.create(
      { id: 'edged-resume', provider: 'codex', cwd: appPath, sessionId: 'saved-session' },
      owner
    )

    const requests = recordedRequests(recordPath)
    assert.deepEqual(
      requests.map((request) => request.method),
      ['session/new', 'session/new', 'session/load']
    )
    assert.deepEqual(requests[0]?.params.mcpServers, [server])
    // No edge, no server: the definition alone would cost every session ~100-300 tokens.
    assert.deepEqual(requests[1]?.params.mcpServers, [])
    // A resume is a creation too - the tool must survive the restart that adopted it.
    assert.deepEqual(requests[2]?.params.mcpServers, [server])

    // The launch-time truth the canvas's adoption rule compares the live edge set against.
    assert.equal(edged.terminalContext, true)
    assert.equal(plain.terminalContext, undefined)
    assert.equal(resumed.terminalContext, true)
  } finally {
    manager.killAll()
  }
})

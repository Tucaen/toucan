import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'
import type { WebContents } from 'electron'
import { createAcpSessionManager } from '../src/main/acp-session-manager'

/**
 * A Claude adapter whose turn stays open until the test releases it: the prompt is answered only
 * once a `release` extension request arrives, so a test can look at the manager mid-turn.
 */
function heldTurnAdapter(appPath: string): void {
  const directory = join(appPath, 'node_modules', '@agentclientprotocol', 'claude-agent-acp', 'dist')
  mkdirSync(directory, { recursive: true })
  writeFileSync(
    join(directory, 'index.js'),
    `
const readline = require('node:readline')
const lines = readline.createInterface({ input: process.stdin })
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n')
let held = null
lines.on('line', (line) => {
  const request = JSON.parse(line)
  if (request.method === 'initialize') {
    send({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } })
  } else if (request.method === 'session/new') {
    send({ jsonrpc: '2.0', id: request.id, result: { sessionId: 'live-session' } })
  } else if (request.method === 'session/prompt') {
    held = request.id
    // The turn ends by itself shortly after the test has looked; no second channel is needed.
    setTimeout(() => send({ jsonrpc: '2.0', id: held, result: { stopReason: 'end_turn' } }), 400)
  }
})
`,
    'utf8'
  )
}

async function until(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (condition()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('condition not reached')
}

test('a session is working for exactly as long as its turn is in flight', async () => {
  const appPath = mkdtempSync(join(tmpdir(), 'toucan-working-sessions-'))
  heldTurnAdapter(appPath)
  const owner = { isDestroyed: () => false, send: () => {} } as unknown as WebContents
  const manager = createAcpSessionManager({ appPath })

  try {
    await manager.create({ id: 'node-1', provider: 'claude', cwd: appPath }, owner)
    assert.deepEqual(manager.workingSessions(), [], 'a ready session has nothing in flight')

    const turn = manager.prompt('node-1', 'Do the thing.')
    await until(() => manager.workingSessions().length > 0)
    assert.deepEqual(manager.workingSessions(), ['node-1'])
    assert.deepEqual(manager.backgroundWork(), [], 'mid-turn is not background work')

    await turn
    assert.deepEqual(manager.workingSessions(), [])

    const second = manager.prompt('node-1', 'Again.')
    await until(() => manager.workingSessions().length > 0)
    manager.kill('node-1')
    assert.deepEqual(manager.workingSessions(), [], 'a stopped session is gone')
    await second.catch(() => undefined)
  } finally {
    manager.killAll()
  }
})

import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { WebContents } from 'electron'
import { createAcpSessionManager } from '../src/main/acp-session-manager'

function replayingAdapter(appPath: string): void {
  const directory = join(
    appPath,
    'node_modules',
    '@agentclientprotocol',
    'claude-agent-acp',
    'dist'
  )
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'index.js'), `
const readline = require('node:readline')
const lines = readline.createInterface({ input: process.stdin })
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n')
lines.on('line', (line) => {
  const request = JSON.parse(line)
  if (request.method === 'initialize') {
    send({ jsonrpc: '2.0', id: request.id, result: {
      protocolVersion: 1,
      agentCapabilities: { loadSession: true },
      authMethods: []
    } })
  } else if (request.method === 'session/load') {
    const sessionId = request.params.sessionId
    send({ jsonrpc: '2.0', method: 'session/update', params: {
      sessionId,
      update: {
        sessionUpdate: 'user_message_chunk',
        messageId: 'saved-user',
        content: { type: 'text', text: 'Persisted question' }
      }
    } })
    send({ jsonrpc: '2.0', method: 'session/update', params: {
      sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'saved-assistant',
        content: { type: 'text', text: 'Persisted answer' }
      }
    } })
    send({ jsonrpc: '2.0', id: request.id, result: {} })
  }
})
`, 'utf8')
}

test('returns session/load transcript notifications atomically instead of streaming them separately', async () => {
  const appPath = mkdtempSync(join(tmpdir(), 'ade-replay-adapter-'))
  replayingAdapter(appPath)
  const streamed: unknown[] = []
  const owner = {
    isDestroyed: () => false,
    send: (channel: string, payload: unknown) => streamed.push({ channel, payload })
  } as unknown as WebContents
  const manager = createAcpSessionManager({ appPath })

  try {
    const result = await manager.create({
      id: 'restored-node',
      provider: 'claude',
      cwd: appPath,
      sessionId: 'saved-conversation'
    }, owner)

    assert.equal(result.status, 'ready')
    assert.equal(result.sessionId, 'saved-conversation')
    assert.deepEqual(result.replay, [
      {
        type: 'message',
        role: 'user',
        messageId: 'saved-user',
        text: 'Persisted question'
      },
      {
        type: 'message',
        role: 'assistant',
        messageId: 'saved-assistant',
        text: 'Persisted answer'
      }
    ])
    assert.equal(streamed.some((entry) => JSON.stringify(entry).includes('Persisted question')), false)
  } finally {
    manager.killAll()
  }
})

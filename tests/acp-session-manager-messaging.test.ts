import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'
import type { WebContents } from 'electron'
import { agentProcessEnvironment, createAcpSessionManager } from '../src/main/acp-session-manager'
import { createMessagingEndpoint } from '../src/main/messaging-endpoint'
import { MESSAGING_TOKEN_ENV, MESSAGING_URL_ENV } from '../src/shared/session-messaging'
import { installScriptedAdapter, type AdapterPackage } from './helpers/scripted-adapter'

// #2: every session Toucan launches - Claude or Codex, chat, ticket or orchestrator - carries a
// messaging token naming its node and the messaging instruction; stopping it revokes the token.

interface Recorded {
  params: { additionalDirectories?: string[]; _meta?: { systemPrompt?: { append: string } } }
  env: { url?: string; token?: string; nodeId?: string; config?: string }
}

function recordingAdapter(appPath: string, adapter: AdapterPackage): string {
  const recordPath = join(appPath, `${adapter}-requests.json`)
  installScriptedAdapter(appPath, adapter, {
    prelude: `
const fs = require('node:fs')
const env = {
  url: process.env.${MESSAGING_URL_ENV},
  token: process.env.${MESSAGING_TOKEN_ENV},
  nodeId: process.env.TOUCAN_NODE_ID,
  config: process.env.CODEX_CONFIG
}
const record = (request) => fs.appendFileSync(${JSON.stringify(recordPath)}, JSON.stringify({ params: request.params, env }) + '\\n')`,
    handleRequest: `
  if (request.method === 'session/new' || request.method === 'session/load') {
    record(request)
    send({ jsonrpc: '2.0', id: request.id, result: { sessionId: 'conversation-' + env.nodeId } })
  }`
  })
  return recordPath
}

function recorded(recordPath: string): Recorded[] {
  return readFileSync(recordPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Recorded)
}

const owner = { isDestroyed: () => false, send: () => {} } as unknown as WebContents

test('an inherited messaging token never reaches a session', () => {
  const environment = agentProcessEnvironment(
    { PATH: '/usr/bin', [MESSAGING_URL_ENV]: 'http://127.0.0.1:1/message', [MESSAGING_TOKEN_ENV]: 'leaked' },
    'node-1'
  )
  assert.equal(environment[MESSAGING_URL_ENV], undefined)
  assert.equal(environment[MESSAGING_TOKEN_ENV], undefined)
})

test('Claude and Codex sessions carry their own token and the messaging instruction', async () => {
  const appPath = mkdtempSync(join(tmpdir(), 'toucan-acp-messaging-'))
  const claudeRecord = recordingAdapter(appPath, 'claude-agent-acp')
  const codexRecord = recordingAdapter(appPath, 'codex-acp')
  const nodes: string[] = []
  const endpoint = createMessagingEndpoint({
    messenger: {
      execute: (nodeId) => {
        nodes.push(nodeId)
        return Promise.resolve({ status: 200, body: { ok: true } })
      }
    }
  })
  const manager = createAcpSessionManager({
    appPath,
    environment: { PATH: process.env.PATH, [MESSAGING_TOKEN_ENV]: 'inherited' },
    messaging: endpoint
  })
  try {
    assert.equal((await manager.create({ id: 'claude-chat', provider: 'claude', cwd: appPath }, owner)).status, 'ready')
    assert.equal(
      (
        await manager.create(
          { id: 'claude-orchestrator', provider: 'claude', cwd: appPath, role: 'orchestrator' },
          owner
        )
      ).status,
      'ready'
    )
    assert.equal((await manager.create({ id: 'codex-chat', provider: 'codex', cwd: appPath }, owner)).status, 'ready')
    const [chat, orchestrator] = recorded(claudeRecord)
    const [codex] = recorded(codexRecord)
    const skillDirectory = join(appPath, '.agents', 'skills', 'session-messaging')
    for (const claude of [chat!, orchestrator!]) {
      assert.match(claude.env.url ?? '', /^http:\/\/127\.0\.0\.1:\d+\/message$/)
      assert.ok(claude.env.token && claude.env.token !== 'inherited')
      assert.match(
        claude.params._meta?.systemPrompt?.append ?? '',
        /session-messaging[\\/]scripts[\\/]message\.mjs" list/
      )
      assert.ok(claude.params.additionalDirectories?.includes(skillDirectory))
    }
    assert.notEqual(chat!.env.token, orchestrator!.env.token)
    assert.ok(codex!.env.token)
    assert.match(codex!.env.config ?? '', /message\.mjs/)
    assert.match(codex!.env.config ?? '', /Prefer session-records and git for past facts/)

    // The token names its node to the endpoint; stopping the session revokes it.
    const call = (env: Recorded['env']) =>
      fetch(env.url!, {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.token}` },
        body: JSON.stringify({ command: 'list' })
      }).then((response) => response.status)
    assert.equal(await call(chat!.env), 200)
    assert.equal(await call(codex!.env), 200)
    assert.deepEqual(nodes, ['claude-chat', 'codex-chat'])
    manager.kill('claude-chat')
    assert.equal(await call(chat!.env), 401)
  } finally {
    manager.killAll()
    await endpoint.close()
  }
})

test('without the endpoint wired in, a session carries no token and no instruction', async () => {
  const appPath = mkdtempSync(join(tmpdir(), 'toucan-acp-no-messaging-'))
  const claudeRecord = recordingAdapter(appPath, 'claude-agent-acp')
  const manager = createAcpSessionManager({ appPath, environment: { PATH: process.env.PATH } })
  try {
    await manager.create({ id: 'plain', provider: 'claude', cwd: appPath }, owner)
    const [plain] = recorded(claudeRecord)
    assert.equal(plain!.env.token, undefined)
    assert.doesNotMatch(plain!.params._meta?.systemPrompt?.append ?? '', /message\.mjs/)
  } finally {
    manager.killAll()
  }
})

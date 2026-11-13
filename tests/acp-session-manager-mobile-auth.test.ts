import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, vi } from 'vitest'
import type { WebContents } from 'electron'
import { createAcpSessionManager } from '../src/main/acp-session-manager'
import { spawnAgentProcess } from '../src/main/agent-process'
import { createAgentEventBroker } from '../src/main/agent-event-broker'
import { installScriptedAdapter, stubAdapterChild } from './helpers/scripted-adapter'

const owner = { isDestroyed: () => false, send: () => {} } as unknown as WebContents

test('expired Claude authentication can be restored remotely without replacing the live conversation or exposing a code', async () => {
  const appPath = mkdtempSync(join(tmpdir(), 'toucan-mobile-auth-'))
  const recordPath = join(appPath, 'methods.jsonl')
  installScriptedAdapter(appPath, 'claude-agent-acp', {
    authMethods: [
      {
        id: 'claude-ai-login',
        name: 'Claude Subscription',
        type: 'terminal',
        args: ['--cli', 'auth', 'login', '--claudeai']
      }
    ],
    prelude: `const fs = require('node:fs')`,
    handleRequest: `
      fs.appendFileSync(${JSON.stringify(recordPath)}, JSON.stringify({ method: request.method, sessionId: request.params?.sessionId }) + '\\n')
      if (request.method === 'session/new') send({ jsonrpc: '2.0', id: request.id, result: { sessionId: 'original-conversation' } })
      if (request.method === 'session/load') send({ jsonrpc: '2.0', id: request.id, result: {} })
      if (request.method === 'session/prompt') send({ jsonrpc: '2.0', id: request.id, error: { code: -32603, message: 'OAuth session expired and could not be refreshed', data: { errorKind: 'authentication_failed' } } })
    `
  })
  const authChild = stubAdapterChild()
  authChild.kill = () => {
    queueMicrotask(() => authChild.emit('exit', null, 'SIGTERM'))
    return true
  }
  const launches: string[][] = []
  const broker = createAgentEventBroker()
  const manager = createAcpSessionManager({
    appPath,
    environment: { PATH: process.env.PATH },
    broker,
    spawnAgent: (launch) => {
      launches.push(launch.args)
      assert.equal(launch.options.windowsHide, true)
      if (launch.args.includes('--cli')) return authChild
      return spawnAgentProcess(launch)
    }
  })
  try {
    assert.equal(
      (await manager.create({ id: 'chat', provider: 'claude', cwd: appPath }, owner)).sessionId,
      'original-conversation'
    )
    assert.equal((await manager.prompt('chat', 'A test prompt')).ok, false)
    assert.equal(broker.snapshot('chat')?.status, 'auth_required')
    assert.equal(manager.authenticationState('chat')?.required, true)
    assert.equal(manager.startAuthentication('chat', 'claude-ai-login').ok, true)
    const attempt = manager.authenticationState('chat')!.attempt!
    authChild.stdout.write('Authorize: https://claude.ai/oauth/authorize?state=test-state\n')
    assert.equal(manager.startAuthentication('chat', 'claude-ai-login').ok, false)
    assert.equal((await manager.submitAuthenticationCode('chat', 'stale', 'private-test-code')).ok, false)
    assert.equal((await manager.submitAuthenticationCode('chat', attempt.id, 'private-test-code')).ok, true)
    authChild.stderr.write('private-test-code must never be a status\n')
    authChild.emit('exit', 0)
    await vi.waitFor(() => assert.equal(manager.authenticationState('chat')?.attempt?.status, 'succeeded'))
    assert.equal(manager.authenticationState('chat')?.required, false)
    assert.equal(broker.snapshot('chat')?.sessionId, 'original-conversation')
    assert.equal(broker.snapshot('chat')?.status, 'ready')
    const requests = readFileSync(recordPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { method: string; sessionId?: string })
    assert.deepEqual(
      requests.filter((request) => ['session/new', 'session/load'].includes(request.method)),
      [{ method: 'session/new' }, { method: 'session/load', sessionId: 'original-conversation' }]
    )
    assert.equal(launches.length, 2, 'reauth launches one helper and retains the same adapter')
    assert.doesNotMatch(JSON.stringify(broker.snapshot('chat')), /private-test-code|test-state|oauth\/authorize/)
  } finally {
    manager.killAll()
  }
})

test('the pinned Codex device elicitation can be cancelled remotely while the adapter and conversation stay alive', async () => {
  const appPath = mkdtempSync(join(tmpdir(), 'toucan-mobile-codex-auth-'))
  installScriptedAdapter(appPath, 'codex-acp', {
    authMethods: [
      { id: 'chat-gpt-device-code', name: 'ChatGPT (device code)', type: 'agent' },
      { id: 'chat-gpt', name: 'ChatGPT', type: 'agent' }
    ],
    prelude: 'let authId',
    handleRequest: `
      if (request.method === 'session/new') send({ jsonrpc: '2.0', id: request.id, result: { sessionId: 'codex-conversation' } })
      if (request.method === 'session/prompt') send({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message: 'Authentication required' } })
      if (request.method === 'authenticate') {
        authId = request.id
        send({ jsonrpc: '2.0', id: 'device-request', method: 'elicitation/create', params: { mode: 'url', requestId: request.id, url: 'https://auth.openai.com/codex/device', message: 'Sign in to ChatGPT and enter this code: TEST-1234', elicitationId: 'login-id' } })
      }
      if (request.id === 'device-request' && request.result?.action === 'cancel') send({ jsonrpc: '2.0', id: authId, error: { code: -32800, message: 'Cancelled private-provider-detail' } })
    `
  })
  const broker = createAgentEventBroker()
  const manager = createAcpSessionManager({ appPath, environment: { PATH: process.env.PATH }, broker })
  try {
    await manager.create({ id: 'codex', provider: 'codex', cwd: appPath }, owner)
    await manager.prompt('codex', 'Test expired auth')
    assert.deepEqual(
      manager.authenticationState('codex')?.methods.map((method) => method.id),
      ['chat-gpt-device-code']
    )
    assert.equal(manager.startAuthentication('codex', 'chat-gpt').ok, false)
    assert.equal(manager.startAuthentication('codex', 'chat-gpt-device-code').ok, true)
    await vi.waitFor(() => assert.equal(manager.authenticationState('codex')?.attempt?.status, 'waiting'))
    assert.equal(manager.authenticationState('codex')?.attempt?.userCode, 'TEST-1234')
    assert.equal(manager.cancelAuthentication('codex', manager.authenticationState('codex')!.attempt!.id).ok, true)
    await vi.waitFor(() => assert.equal(manager.authenticationState('codex')?.attempt?.status, 'cancelled'))
    assert.equal(manager.authenticationState('codex')?.required, true)
    assert.equal(broker.snapshot('codex')?.sessionId, 'codex-conversation')
    assert.equal(broker.snapshot('codex')?.status, 'auth_required')
    assert.doesNotMatch(JSON.stringify(broker.snapshot('codex')), /TEST-1234|private-provider-detail/)
  } finally {
    manager.killAll()
  }
})

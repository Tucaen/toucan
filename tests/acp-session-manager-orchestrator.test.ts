import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'
import type { WebContents } from 'electron'
import { agentProcessEnvironment, createAcpSessionManager } from '../src/main/acp-session-manager'
import { createOrchestrationStore } from '../src/main/orchestration-store'
import { createOrchestratorEndpoint } from '../src/main/orchestrator-endpoint'
import { ORCHESTRATOR_TOKEN_ENV, ORCHESTRATOR_URL_ENV } from '../src/shared/orchestration'
import { isAgentCreateRequest } from '../src/main/register-agent-ipc'
import { installScriptedAdapter, type AdapterPackage } from './helpers/scripted-adapter'

// #33: launching an orchestrator mints a per-node token and passes it to the adapter process in its
// environment beside TOUCAN_NODE_ID, with the orchestration instruction on its system prompt.
// Closing the node revokes it, and no other session carries one.

interface Recorded {
  method: string
  params: { _meta?: { systemPrompt?: { append: string } } }
  env: { url?: string; token?: string; nodeId?: string }
}

function recordingAdapter(appPath: string, adapter: AdapterPackage): string {
  const recordPath = join(appPath, `${adapter}-requests.json`)
  installScriptedAdapter(appPath, adapter, {
    prelude: `
const fs = require('node:fs')
const env = {
  url: process.env.${ORCHESTRATOR_URL_ENV},
  token: process.env.${ORCHESTRATOR_TOKEN_ENV},
  nodeId: process.env.TOUCAN_NODE_ID
}
const record = (request) => fs.appendFileSync(${JSON.stringify(recordPath)}, JSON.stringify({ method: request.method, params: request.params, env }) + '\\n')`,
    handleRequest: `
  if (request.method === 'session/new') {
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

async function planShow(env: Recorded['env']): Promise<number> {
  const response = await fetch(env.url!, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.token}` },
    body: JSON.stringify({ command: 'plan show' })
  })
  return response.status
}

test('an ordinary session never carries an orchestrator token, not even one Toucan inherited', () => {
  const environment = agentProcessEnvironment(
    { PATH: '/usr/bin', [ORCHESTRATOR_URL_ENV]: 'http://127.0.0.1:1/orchestrate', [ORCHESTRATOR_TOKEN_ENV]: 'leaked' },
    'node-1'
  )
  assert.equal(environment[ORCHESTRATOR_URL_ENV], undefined)
  assert.equal(environment[ORCHESTRATOR_TOKEN_ENV], undefined)
  assert.equal(environment.TOUCAN_NODE_ID, 'node-1')
})

test('only an orchestrator Claude session gets a token and the instruction; closing it revokes', async () => {
  const appPath = mkdtempSync(join(tmpdir(), 'toucan-acp-orchestrator-'))
  const claudeRecord = recordingAdapter(appPath, 'claude-agent-acp')
  const codexRecord = recordingAdapter(appPath, 'codex-acp')
  const endpoint = createOrchestratorEndpoint({
    records: createOrchestrationStore({ directory: join(appPath, 'orchestrations') })
  })
  const manager = createAcpSessionManager({
    appPath,
    environment: { PATH: process.env.PATH, [ORCHESTRATOR_TOKEN_ENV]: 'inherited-from-a-parent-orchestrator' },
    orchestrator: endpoint
  })
  try {
    const orchestrator = await manager.create(
      { id: 'orchestrator', provider: 'claude', cwd: appPath, role: 'orchestrator' },
      owner
    )
    assert.equal(orchestrator.status, 'ready')
    await manager.create({ id: 'plain', provider: 'claude', cwd: appPath }, owner)
    // Claude only in the first version: a Codex node claiming the role gets nothing.
    await manager.create({ id: 'codex', provider: 'codex', cwd: appPath, role: 'orchestrator' }, owner)

    const [orchestratorOpen, plainOpen] = recorded(claudeRecord)
    const [codexOpen] = recorded(codexRecord)
    assert.equal(orchestratorOpen?.env.nodeId, 'orchestrator')
    assert.match(orchestratorOpen?.env.url ?? '', /^http:\/\/127\.0\.0\.1:\d+\/orchestrate$/)
    assert.ok(orchestratorOpen?.env.token)
    assert.notEqual(orchestratorOpen?.env.token, 'inherited-from-a-parent-orchestrator')
    assert.match(orchestratorOpen?.params._meta?.systemPrompt?.append ?? '', /You are a Toucan orchestrator/)
    assert.match(
      orchestratorOpen?.params._meta?.systemPrompt?.append ?? '',
      /orchestrate[\\/]scripts[\\/]orchestrate\.mjs" plan show/
    )

    for (const other of [plainOpen, codexOpen]) {
      assert.deepEqual(other?.env, { nodeId: other?.env.nodeId })
      assert.doesNotMatch(other?.params._meta?.systemPrompt?.append ?? '', /orchestrator/)
    }

    // The token works, scoped to the conversation its session opened.
    assert.equal(await planShow(orchestratorOpen!.env), 200)
    manager.kill('orchestrator')
    // Revoked, and with no orchestrator left the port is closed as well.
    assert.equal(endpoint.listening(), false)
  } finally {
    manager.killAll()
    await endpoint.close()
  }
})

test('the create request carries the role across the privilege seam only as the orchestrator role', () => {
  const request = { id: 'node', provider: 'claude', cwd: '/project' }
  assert.equal(isAgentCreateRequest({ ...request, role: 'orchestrator' }), true)
  assert.equal(isAgentCreateRequest(request), true)
  assert.equal(isAgentCreateRequest({ ...request, role: 'admin' }), false)
})

test('a grant is scoped to the project checkout, and one still pending when the node closes is revoked', async () => {
  const appPath = mkdtempSync(join(tmpdir(), 'toucan-acp-orchestrator-scope-'))
  recordingAdapter(appPath, 'claude-agent-acp')
  const scopes: Array<{ nodeId: string; projectPath: string }> = []
  let revoked = 0
  let release: () => void = () => undefined
  const manager = createAcpSessionManager({
    appPath,
    environment: { PATH: process.env.PATH },
    projectPathFor: async (cwd) => (cwd === appPath ? 'D:\\checkout' : undefined),
    orchestrator: {
      grant: async (nodeId, scope) => {
        scopes.push({ nodeId, projectPath: scope.projectPath })
        if (nodeId === 'slow') await new Promise<void>((resolve) => (release = resolve))
        return {
          environment: { [ORCHESTRATOR_URL_ENV]: 'http://127.0.0.1:1/orchestrate', [ORCHESTRATOR_TOKEN_ENV]: 't' },
          setConversation: () => undefined,
          revoke: () => {
            revoked += 1
          }
        }
      }
    }
  })
  try {
    await manager.create({ id: 'worktree', provider: 'claude', cwd: appPath, role: 'orchestrator' }, owner)
    assert.deepEqual(scopes[0], { nodeId: 'worktree', projectPath: 'D:\\checkout' })

    const pending = manager.create({ id: 'slow', provider: 'claude', cwd: appPath, role: 'orchestrator' }, owner)
    await new Promise((resolve) => setTimeout(resolve, 20))
    manager.kill('slow')
    release()
    const result = await pending
    assert.equal(result.ok, false)
    assert.equal(revoked, 1)
  } finally {
    manager.killAll()
  }
})

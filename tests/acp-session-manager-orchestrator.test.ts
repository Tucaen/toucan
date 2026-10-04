import { strict as assert } from 'node:assert'
import { cpSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, vi } from 'vitest'
import type { WebContents } from 'electron'
import { agentProcessEnvironment, createAcpSessionManager } from '../src/main/acp-session-manager'
import { createOrchestrationStore } from '../src/main/orchestration-store'
import { createOrchestratorEndpoint } from '../src/main/orchestrator-endpoint'
import { ORCHESTRATOR_TOKEN_ENV, ORCHESTRATOR_URL_ENV, type OrchestrationRecord } from '../src/shared/orchestration'
import { isAgentCreateRequest } from '../src/main/register-agent-ipc'
import { installScriptedAdapter, type AdapterPackage } from './helpers/scripted-adapter'

// #33: launching an orchestrator mints a per-node token and passes it to the adapter process in its
// environment beside TOUCAN_NODE_ID, with the orchestration instruction on its system prompt.
// Closing the node revokes it, and no other session carries one.

interface Recorded {
  method: string
  params: { additionalDirectories?: string[]; _meta?: { systemPrompt?: { append: string } } }
  env: { url?: string; token?: string; nodeId?: string; config?: string }
}

function recordingAdapter(appPath: string, adapter: AdapterPackage): string {
  const recordPath = join(appPath, `${adapter}-requests.json`)
  installScriptedAdapter(appPath, adapter, {
    prelude: `
const fs = require('node:fs')
const env = {
  url: process.env.${ORCHESTRATOR_URL_ENV},
  token: process.env.${ORCHESTRATOR_TOKEN_ENV},
  nodeId: process.env.TOUCAN_NODE_ID,
  config: process.env.CODEX_CONFIG
}
const record = (request) => fs.appendFileSync(${JSON.stringify(recordPath)}, JSON.stringify({ method: request.method, params: request.params, env }) + '\\n')`,
    handleRequest: `
  if (request.method === 'session/new' || request.method === 'session/load') {
    record(request)
    send({ jsonrpc: '2.0', id: request.id, result: { sessionId: request.params.sessionId || 'conversation-' + env.nodeId } })
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

test('a Claude orchestrator keeps its grant and instruction while ordinary chats receive neither', async () => {
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
    await manager.create({ id: 'codex', provider: 'codex', cwd: appPath }, owner)

    const [orchestratorOpen, plainOpen] = recorded(claudeRecord)
    const [codexOpen] = recorded(codexRecord)
    assert.equal(orchestratorOpen?.env.nodeId, 'orchestrator')
    assert.match(orchestratorOpen?.env.url ?? '', /^http:\/\/127\.0\.0\.1:\d+\/orchestrate$/)
    assert.ok(orchestratorOpen?.env.token)
    assert.notEqual(orchestratorOpen?.env.token, 'inherited-from-a-parent-orchestrator')
    assert.match(orchestratorOpen?.params._meta?.systemPrompt?.append ?? '', /You are a Toucan orchestrator/)
    assert.ok(
      orchestratorOpen.params.additionalDirectories?.includes(join(appPath, '.agents', 'skills', 'orchestrate'))
    )
    assert.match(
      orchestratorOpen?.params._meta?.systemPrompt?.append ?? '',
      /orchestrate[\\/]scripts[\\/]orchestrate\.mjs" plan show/
    )

    for (const other of [plainOpen, codexOpen]) {
      assert.deepEqual(other?.env, { nodeId: other?.env.nodeId })
      assert.doesNotMatch(other?.params._meta?.systemPrompt?.append ?? '', /orchestrator/)
      assert.ok(!other.params.additionalDirectories?.includes(join(appPath, '.agents', 'skills', 'orchestrate')))
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

test('a Codex orchestrator gets its grant and appends the workflow to native session instructions', async () => {
  const appPath = mkdtempSync(join(tmpdir(), 'toucan-codex-orchestrator-'))
  const recordPath = recordingAdapter(appPath, 'codex-acp')
  const endpoint = createOrchestratorEndpoint({
    records: createOrchestrationStore({ directory: join(appPath, 'orchestrations') })
  })
  const manager = createAcpSessionManager({
    appPath,
    environment: {
      PATH: process.env.PATH,
      CODEX_CONFIG: JSON.stringify({ developer_instructions: 'User instruction', model: 'user-model' }),
      [ORCHESTRATOR_URL_ENV]: 'http://127.0.0.1:1/orchestrate',
      [ORCHESTRATOR_TOKEN_ENV]: 'inherited-token'
    },
    sessionOutcomesDirectory: join(appPath, 'outcomes'),
    orchestrator: endpoint
  })
  try {
    const result = await manager.create(
      {
        id: 'codex-orchestrator',
        provider: 'codex',
        cwd: appPath,
        role: 'orchestrator',
        routineDelegation: { workerModelId: 'gpt-5.6-luna', workerEffortId: 'low' }
      },
      owner
    )
    assert.equal(result.status, 'ready')
    const [opened] = recorded(recordPath)
    const config = JSON.parse(opened.env.config!) as { developer_instructions: string; model: string }
    assert.match(config.developer_instructions, /^User instruction/)
    assert.match(config.developer_instructions, /routine/i)
    assert.match(config.developer_instructions, /session-outcomes|outcomes/)
    assert.match(config.developer_instructions, /You are a Toucan orchestrator/)
    assert.match(config.developer_instructions, /orchestrate[\\/]SKILL\.md/)
    assert.match(config.developer_instructions, /orchestrate[\\/]scripts[\\/]orchestrate\.mjs" plan show/)
    assert.equal(config.model, 'user-model')
    assert.equal(opened.params._meta?.systemPrompt, undefined)
    assert.ok(opened.params.additionalDirectories?.includes(join(appPath, '.agents', 'skills', 'orchestrate')))
    assert.notEqual(opened.env.token, 'inherited-token')
    assert.equal(await planShow(opened.env), 200)

    await manager.create({ id: 'plain-codex', provider: 'codex', cwd: appPath }, owner)
    const plain = recorded(recordPath)[1]
    assert.equal(plain.env.url, undefined)
    assert.equal(plain.env.token, undefined)
    const plainConfig = JSON.parse(plain.env.config!) as { developer_instructions: string }
    assert.doesNotMatch(plainConfig.developer_instructions, /You are a Toucan orchestrator/)
    manager.kill('codex-orchestrator')
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

test.each(['claude', 'codex'] as const)(
  'a %s grant is scoped to the checkout and revoked if stopped while pending',
  async (provider) => {
    const appPath = mkdtempSync(join(tmpdir(), 'toucan-acp-orchestrator-scope-'))
    recordingAdapter(appPath, provider === 'claude' ? 'claude-agent-acp' : 'codex-acp')
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
      await manager.create({ id: 'worktree', provider, cwd: appPath, role: 'orchestrator' }, owner)
      assert.deepEqual(scopes[0], { nodeId: 'worktree', projectPath: 'D:\\checkout' })

      const pending = manager.create({ id: 'slow', provider, cwd: appPath, role: 'orchestrator' }, owner)
      await vi.waitFor(() => assert.equal(scopes.length, 2))
      manager.kill('slow')
      release()
      const result = await pending
      assert.equal(result.ok, false)
      assert.equal(revoked, 1)
    } finally {
      manager.killAll()
    }
  }
)

test('a Codex launch reads the shipped workflow and runs durable plan commands; resume rotates and exit revokes its grant', async () => {
  const appPath = mkdtempSync(join(tmpdir(), 'toucan-codex-plan-'))
  cpSync(join(process.cwd(), '.agents', 'skills', 'orchestrate'), join(appPath, '.agents', 'skills', 'orchestrate'), {
    recursive: true
  })
  const recordPath = join(appPath, 'cli-results.json')
  installScriptedAdapter(appPath, 'codex-acp', {
    prelude: `
const fs = require('node:fs')
const { execFile } = require('node:child_process')
const instruction = JSON.parse(process.env.CODEX_CONFIG).developer_instructions
const skill = instruction.match(/workflow at "([^"]+)"/)[1]
const cli = instruction.match(/node "([^"]+)" plan show/)[1]
const workflow = fs.readFileSync(skill, 'utf8')
const record = (value) => fs.appendFileSync(${JSON.stringify(recordPath)}, JSON.stringify(value) + '\\n')`,
    handleRequest: `
  if (request.method === 'session/new' || request.method === 'session/load') {
    record({ token: process.env.${ORCHESTRATOR_TOKEN_ENV}, url: process.env.${ORCHESTRATOR_URL_ENV}, workflow })
    send({ jsonrpc: '2.0', id: request.id, result: { sessionId: 'durable-conversation' } })
  } else if (request.method === 'session/prompt') {
    const text = request.params.prompt[0].text
    if (text === 'exit') { process.exit(0); return }
    execFile(process.execPath, [cli, ...JSON.parse(text)], { windowsHide: true }, (error, stdout) => {
      record({ code: error ? error.code : 0, output: JSON.parse(stdout.trim()) })
      send({ jsonrpc: '2.0', id: request.id, result: { stopReason: 'end_turn' } })
    })
  }`
  })
  const directory = join(appPath, 'orchestrations')
  const records = createOrchestrationStore({ directory })
  const endpoint = createOrchestratorEndpoint({ records })
  // Keep the listener up so revoked tokens must answer 401, not just hit a closed port.
  const keeper = (await endpoint.grant('keeper', { provider: 'claude', projectPath: appPath }))!
  keeper.setConversation('other-conversation')
  const manager = createAcpSessionManager({ appPath, environment: { PATH: process.env.PATH }, orchestrator: endpoint })
  interface CliEvidence {
    token?: string
    url?: string
    workflow?: string
    code?: number
    output?: { record: OrchestrationRecord }
  }
  const results = (): CliEvidence[] =>
    readFileSync(recordPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as CliEvidence)
  const request = { id: 'codex', provider: 'codex' as const, cwd: appPath, role: 'orchestrator' as const }
  const plan = { task: 'Durable Codex plan', targetBranch: 'main', tickets: [{ id: '43', title: 'Planning' }] }
  try {
    assert.equal((await manager.create(request, owner)).status, 'ready')
    const first = results()[0]
    assert.ok(first.workflow)
    assert.match(first.workflow, /name: orchestrate/)
    assert.equal(
      (await manager.prompt('codex', JSON.stringify(['plan', 'set', '--json', JSON.stringify(plan)]))).ok,
      true
    )
    assert.equal(results().at(-1)?.code, 0)
    assert.equal((await manager.prompt('codex', JSON.stringify(['plan', 'show']))).ok, true)
    const shown = results().at(-1)
    assert.ok(shown?.output)
    assert.equal(shown.code, 0)
    assert.equal(shown.output.record.task, plan.task)
    assert.equal(shown.output.record.provider, 'codex')
    assert.equal(shown.output.record.conversationId, 'durable-conversation')
    assert.equal(shown.output.record.projectPath, appPath)
    assert.deepEqual(
      await createOrchestrationStore({ directory }).read({ provider: 'codex', conversationId: 'durable-conversation' }),
      shown.output.record
    )
    assert.equal(await records.read({ provider: 'claude', conversationId: 'durable-conversation' }), undefined)

    manager.kill('codex')
    assert.equal(await planShow(first), 401)
    assert.equal((await manager.create({ ...request, sessionId: 'durable-conversation' }, owner)).status, 'ready')
    const resumed = results().at(-1)
    assert.ok(resumed)
    assert.notEqual(resumed.token, first.token)
    assert.equal((await manager.prompt('codex', JSON.stringify(['plan', 'show']))).ok, true)
    assert.deepEqual(results().at(-1)?.output?.record, shown.output.record)
    assert.equal(await planShow(first), 401)

    // A different conversation cannot select this record by supplying its id in the payload.
    const stranger = (await endpoint.grant('stranger', { provider: 'codex', projectPath: appPath }))!
    stranger.setConversation('other-conversation')
    const reply = await fetch(stranger.environment[ORCHESTRATOR_URL_ENV], {
      method: 'POST',
      headers: { Authorization: `Bearer ${stranger.environment[ORCHESTRATOR_TOKEN_ENV]}` },
      body: JSON.stringify({ command: 'plan show', args: { conversationId: 'durable-conversation' } })
    })
    assert.deepEqual(await reply.json(), { ok: true, record: null })
    const elsewhere = (await endpoint.grant('elsewhere', { provider: 'codex', projectPath: join(appPath, 'other') }))!
    elsewhere.setConversation('durable-conversation')
    assert.equal(
      await planShow({
        url: elsewhere.environment[ORCHESTRATOR_URL_ENV],
        token: elsewhere.environment[ORCHESTRATOR_TOKEN_ENV]
      }),
      403
    )

    await manager.prompt('codex', 'exit')
    await vi.waitFor(async () => assert.equal(await planShow(resumed), 401))
  } finally {
    manager.killAll()
    await endpoint.close()
  }
})

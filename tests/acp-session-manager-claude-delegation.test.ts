import { strict as assert } from 'node:assert'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { WebContents } from 'electron'
import type { AgentProcessLaunch } from '../src/main/agent-process'
import { createAcpSessionManager } from '../src/main/acp-session-manager'
import { CLAUDE_ROUTINE_WORKER_NAME } from '../src/shared/routine-delegation'
import { installScriptedAdapter } from './helpers/scripted-adapter'

// Issue #179: a delegating Claude session carries its named routine worker in the adapter's
// session-scoped `_meta` (which claude-agent-acp 0.75.1 spreads into the SDK query options) on both
// `session/new` and `session/load`, never in user-wide settings, the launch environment, or the
// transcript. What the session actually lists as models decides whether the worker is usable.

/**
 * A scripted claude-agent-acp stand-in: appends every session request's params to a file (the
 * test reads it back after `create` settles) and answers with a fixed model list.
 */
function recordingClaudeAdapter(appPath: string, modelValues: string[]): string {
  const recordPath = join(appPath, 'requests.json')
  installScriptedAdapter(appPath, 'claude-agent-acp', {
    prelude: `
const fs = require('node:fs')
// One line per request, appended: every session is its own adapter process sharing this file.
const record = (request) => fs.appendFileSync(${JSON.stringify(recordPath)}, JSON.stringify({ method: request.method, params: request.params }) + '\\n')
const configOptions = [{
  id: 'model', name: 'Model', type: 'select', category: 'model', currentValue: 'default',
  options: ${JSON.stringify(modelValues)}.map((value) => ({ value, name: value }))
}]`,
    handleRequest: `
  if (request.method === 'session/new') {
    record(request)
    send({ jsonrpc: '2.0', id: request.id, result: { sessionId: 'fresh-session', configOptions } })
  } else if (request.method === 'session/load') {
    record(request)
    send({ jsonrpc: '2.0', id: request.id, result: { configOptions } })
  }`
  })
  return recordPath
}

interface RecordedRequest {
  method: string
  params: {
    _meta?: {
      claudeCode?: { options?: Record<string, unknown> }
      systemPrompt?: { type: string; preset: string; append: string }
    }
  }
}

function recordedRequests(recordPath: string): RecordedRequest[] {
  return readFileSync(recordPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as RecordedRequest)
}

const owner = { isDestroyed: () => false, send: () => {} } as unknown as WebContents
const worker = { workerModelId: 'haiku' }

function workerDefinition(request: RecordedRequest): Record<string, unknown> | undefined {
  const agents = request.params._meta?.claudeCode?.options?.agents as
    Record<string, Record<string, unknown>> | undefined
  return agents?.[CLAUDE_ROUTINE_WORKER_NAME]
}

test('a new Claude session receives the named routine worker and routing instruction in session _meta', async () => {
  const appPath = mkdtempSync(join(tmpdir(), 'toucan-claude-delegation-'))
  const recordPath = recordingClaudeAdapter(appPath, ['default', 'sonnet', 'haiku'])
  const launches: AgentProcessLaunch[] = []
  const manager = createAcpSessionManager({
    appPath,
    environment: { PATH: process.env.PATH },
    spawnAgent: (launch) => {
      launches.push(launch)
      // Spawn the scripted adapter for real - the launch environment is what the assertion is about.
      return spawn(launch.executable, launch.args, { ...launch.options, stdio: ['pipe', 'pipe', 'pipe'] })
    }
  })
  try {
    const result = await manager.create(
      { id: 'delegating', provider: 'claude', cwd: appPath, routineDelegation: worker },
      owner
    )
    assert.equal(result.status, 'ready')
    // Launch-time truth: configured, and worded as requested rather than confirmed by the UI.
    assert.deepEqual(result.routineDelegation, { workerModelId: 'haiku', status: 'configured' })

    const [request] = recordedRequests(recordPath)
    assert.equal(request?.method, 'session/new')
    const definition = workerDefinition(request!)
    assert.ok(definition, 'the routine worker definition rides on session/new')
    // The pin is on the definition. The SDK forwards `agents` in its control-protocol initialize
    // request, so nothing is written to ~/.claude and no worker text enters the transcript.
    assert.equal(definition.model, 'haiku')
    assert.ok(!(definition.tools as string[]).includes('Agent'))
    assert.equal(request!.params._meta?.systemPrompt?.preset, 'claude_code')
    assert.match(request!.params._meta?.systemPrompt?.append ?? '', /Delegate routine work cheaply/)
    // Environment isolation: the worker never travels as a process-wide subagent model override.
    const environment = launches[0]?.options.env ?? {}
    assert.equal(environment.CLAUDE_CODE_SUBAGENT_MODEL, undefined)
    assert.equal(environment.CLAUDE_CODE_SUBAGENT_MODEL_FORCE, undefined)
    assert.equal(environment.CODEX_CONFIG, undefined)
  } finally {
    manager.killAll()
  }
})

test('a resumed Claude session carries the same worker on session/load, and a plain one carries nothing', async () => {
  const appPath = mkdtempSync(join(tmpdir(), 'toucan-claude-delegation-'))
  const recordPath = recordingClaudeAdapter(appPath, ['default', 'haiku'])
  const manager = createAcpSessionManager({ appPath, environment: { PATH: process.env.PATH } })
  try {
    const resumed = await manager.create(
      { id: 'resumed', provider: 'claude', cwd: appPath, sessionId: 'saved-session', routineDelegation: worker },
      owner
    )
    assert.equal(resumed.routineDelegation?.status, 'configured')
    const plain = await manager.create({ id: 'plain', provider: 'claude', cwd: appPath }, owner)
    assert.equal(plain.routineDelegation, undefined)

    const requests = recordedRequests(recordPath)
    assert.deepEqual(
      requests.map((request) => request.method),
      ['session/load', 'session/new']
    )
    assert.equal(workerDefinition(requests[0]!)?.model, 'haiku')
    assert.match(requests[0]!.params._meta?.systemPrompt?.append ?? '', /routine-worker/)
    // Off means off: no agent definition and no system-prompt append for a session without the policy.
    assert.equal(workerDefinition(requests[1]!), undefined)
    assert.equal(requests[1]!.params._meta?.systemPrompt, undefined)
  } finally {
    manager.killAll()
  }
})

test('a worker the session does not list is reported unavailable, and the next session is not configured', async () => {
  const appPath = mkdtempSync(join(tmpdir(), 'toucan-claude-delegation-'))
  const recordPath = recordingClaudeAdapter(appPath, ['default', 'opus[1m]', 'sonnet'])
  const manager = createAcpSessionManager({ appPath, environment: { PATH: process.env.PATH } })
  try {
    // The first session has no earlier list to consult, so it launches on trust and is verified
    // against its own list: the CLI would substitute a model missing from its allowlist and only
    // log a warning, which is exactly the silent expensive fallback the note has to make visible.
    const first = await manager.create(
      { id: 'first', provider: 'claude', cwd: appPath, routineDelegation: worker },
      owner
    )
    assert.equal(first.routineDelegation?.status, 'unavailable')
    assert.match(first.routineDelegation?.message ?? '', /does not list haiku/)

    // The second session knows better before it asks: no definition, no instruction.
    const second = await manager.create(
      { id: 'second', provider: 'claude', cwd: appPath, routineDelegation: worker },
      owner
    )
    assert.equal(second.routineDelegation?.status, 'unavailable')
    const requests = recordedRequests(recordPath)
    assert.equal(requests.length, 2)
    assert.equal(workerDefinition(requests[1]!), undefined)
    assert.equal(requests[1]!.params._meta?.systemPrompt, undefined)
  } finally {
    manager.killAll()
  }
})

test('CLAUDE_CODE_SUBAGENT_MODEL_FORCE in the launch environment withholds the worker before launch', async () => {
  const appPath = mkdtempSync(join(tmpdir(), 'toucan-claude-delegation-'))
  const recordPath = recordingClaudeAdapter(appPath, ['default', 'haiku'])
  const manager = createAcpSessionManager({
    appPath,
    environment: { PATH: process.env.PATH, CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '1' }
  })
  try {
    // The CLI ignores every agent-definition model under FORCE, so the worker would run on whatever
    // the environment dictates: refuse visibly instead of registering a pin that cannot hold.
    const result = await manager.create(
      { id: 'forced', provider: 'claude', cwd: appPath, routineDelegation: worker },
      owner
    )
    assert.equal(result.routineDelegation?.status, 'unavailable')
    assert.match(result.routineDelegation?.message ?? '', /CLAUDE_CODE_SUBAGENT_MODEL_FORCE/)
    assert.equal(workerDefinition(recordedRequests(recordPath)[0]!), undefined)
  } finally {
    manager.killAll()
  }
})

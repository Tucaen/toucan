import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'
import type { WebContents } from 'electron'
import { createAcpSessionManager } from '../src/main/acp-session-manager'
import { DECISION_PROVIDER_SKILL_NAME } from '../src/shared/decision-delegation'
import { installScriptedAdapter } from './helpers/scripted-adapter'

// Issue #213: a decision-delegating Claude session carries one extra system-prompt append naming
// the installed decision-provider skill. Claude only in v1, and withheld - visibly, with a reason
// on the create result - for Codex or for a machine that does not have the skill.

function recordingClaudeAdapter(appPath: string): string {
  const recordPath = join(appPath, 'requests.json')
  installScriptedAdapter(appPath, 'claude-agent-acp', {
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
  params: { _meta?: { systemPrompt?: { type: string; preset: string; append: string } } }
}

function recordedRequests(recordPath: string): RecordedRequest[] {
  return readFileSync(recordPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as RecordedRequest)
}

const owner = { isDestroyed: () => false, send: () => {} } as unknown as WebContents

test('a new Claude session carries the decision instruction; a resumed one carries the same', async () => {
  const appPath = mkdtempSync(join(tmpdir(), 'toucan-decision-delegation-'))
  const recordPath = recordingClaudeAdapter(appPath)
  const manager = createAcpSessionManager({
    appPath,
    environment: { PATH: process.env.PATH },
    decisionProviderInstalled: () => true
  })
  try {
    const fresh = await manager.create(
      { id: 'fresh', provider: 'claude', cwd: appPath, decisionDelegation: true },
      owner
    )
    assert.deepEqual(fresh.decisionDelegation, { status: 'configured' })
    const resumed = await manager.create(
      { id: 'resumed', provider: 'claude', cwd: appPath, sessionId: 'saved', decisionDelegation: true },
      owner
    )
    assert.equal(resumed.decisionDelegation?.status, 'configured')
    // Off means off: a session without the policy gets no append at all.
    const plain = await manager.create({ id: 'plain', provider: 'claude', cwd: appPath }, owner)
    assert.equal(plain.decisionDelegation, undefined)

    const requests = recordedRequests(recordPath)
    assert.deepEqual(
      requests.map((request) => request.method),
      ['session/new', 'session/load', 'session/new']
    )
    for (const request of requests.slice(0, 2)) {
      assert.equal(request.params._meta?.systemPrompt?.preset, 'claude_code')
      assert.match(request.params._meta?.systemPrompt?.append ?? '', new RegExp(DECISION_PROVIDER_SKILL_NAME))
    }
    assert.equal(requests[2]!.params._meta?.systemPrompt, undefined)
  } finally {
    manager.killAll()
  }
})

test('both delegation policies travel together on the one system prompt a session gets', async () => {
  const appPath = mkdtempSync(join(tmpdir(), 'toucan-decision-delegation-'))
  const recordPath = recordingClaudeAdapter(appPath)
  const manager = createAcpSessionManager({
    appPath,
    environment: { PATH: process.env.PATH },
    decisionProviderInstalled: () => true
  })
  try {
    await manager.create(
      {
        id: 'both',
        provider: 'claude',
        cwd: appPath,
        routineDelegation: { workerModelId: 'haiku' },
        decisionDelegation: true
      },
      owner
    )
    // `withSessionInstruction` appends, so neither carrier can silently drop the other.
    const append = recordedRequests(recordPath)[0]!.params._meta?.systemPrompt?.append ?? ''
    assert.match(append, /Delegate routine work cheaply/)
    assert.match(append, /Delegate decisions/)
    assert.match(append, /prefer the decision provider over spawning a routine worker/i)
  } finally {
    manager.killAll()
  }
})

test('a missing skill withholds the instruction and says so, rather than pointing at nothing', async () => {
  const appPath = mkdtempSync(join(tmpdir(), 'toucan-decision-delegation-'))
  const recordPath = recordingClaudeAdapter(appPath)
  const manager = createAcpSessionManager({
    appPath,
    environment: { PATH: process.env.PATH },
    decisionProviderInstalled: () => false
  })
  try {
    const result = await manager.create(
      { id: 'no-skill', provider: 'claude', cwd: appPath, decisionDelegation: true },
      owner
    )
    assert.equal(result.decisionDelegation?.status, 'unavailable')
    assert.match(result.decisionDelegation?.message ?? '', /not installed/)
    assert.equal(recordedRequests(recordPath)[0]!.params._meta?.systemPrompt, undefined)
  } finally {
    manager.killAll()
  }
})

test('a Codex session records the request and reports the Claude-only scope instead of dropping it', async () => {
  const appPath = mkdtempSync(join(tmpdir(), 'toucan-decision-delegation-'))
  installScriptedAdapter(appPath, 'codex-acp', {
    handleRequest: `
  if (request.method === 'session/new') {
    send({ jsonrpc: '2.0', id: request.id, result: { sessionId: 'codex-session' } })
  }`
  })
  const manager = createAcpSessionManager({
    appPath,
    environment: { PATH: process.env.PATH },
    decisionProviderInstalled: () => true
  })
  try {
    const result = await manager.create(
      { id: 'codex', provider: 'codex', cwd: appPath, decisionDelegation: true },
      owner
    )
    assert.equal(result.decisionDelegation?.status, 'unavailable')
    assert.match(result.decisionDelegation?.message ?? '', /Claude sessions for now/)
  } finally {
    manager.killAll()
  }
})

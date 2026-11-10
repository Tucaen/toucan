import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'
import type { WebContents } from 'electron'
import { createAcpSessionManager, withWorkflowKeywordTriggerOff } from '../src/main/acp-session-manager'
import { isAgentCreateRequest } from '../src/main/register-agent-ipc'
import { commandGuardFiles, commandGuardSettings } from '../src/main/command-guard'
import { installScriptedAdapter } from './helpers/scripted-adapter'

// claude-agent-acp stamps every prompt `origin: { kind: 'human' }` (since 0.93.0), the only origin
// Claude Code's `ultracode` keyword honours, so text Toucan sends for an orchestrator - a ticket's
// first prompt, a followup, a wake - could start a dynamic workflow. The only lever is the session's
// own settings (`workflowKeywordTriggerEnabled: false`); a plain chat keeps the keyword.

interface Opened {
  method: string
  params: { _meta?: { claudeCode?: { options?: { settings?: Record<string, unknown> } } } }
}

const owner = { isDestroyed: () => false, send: () => {} } as unknown as WebContents

function openedSessions(appPath: string, adapter: 'claude-agent-acp' | 'codex-acp'): { record: string } {
  const record = join(appPath, `${adapter}-opened.json`)
  installScriptedAdapter(appPath, adapter, {
    prelude: `const fs = require('node:fs')`,
    handleRequest: `
  if (request.method === 'session/new' || request.method === 'session/load') {
    fs.appendFileSync(${JSON.stringify(record)}, JSON.stringify({ method: request.method, params: request.params }) + String.fromCharCode(10))
    send({ jsonrpc: '2.0', id: request.id, result: { sessionId: request.params.sessionId || 'fresh-session' } })
  }`
  })
  return { record }
}

const read = (record: string): Opened[] =>
  readFileSync(record, 'utf8')
    .split(String.fromCharCode(10))
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Opened)

const settingsOf = (opened: Opened | undefined): Record<string, unknown> | undefined =>
  opened?.params._meta?.claudeCode?.options?.settings

test('ticket sessions and orchestrators open with the ultracode keyword trigger off; a plain chat does not', async () => {
  const appPath = mkdtempSync(join(tmpdir(), 'toucan-keyword-trigger-'))
  const { record } = openedSessions(appPath, 'claude-agent-acp')
  const manager = createAcpSessionManager({ appPath, environment: { PATH: process.env.PATH } })
  try {
    await manager.create({ id: 'chat', provider: 'claude', cwd: appPath }, owner)
    await manager.create({ id: 'ticket', provider: 'claude', cwd: appPath, orchestrated: true }, owner)
    await manager.create({ id: 'orchestrator', provider: 'claude', cwd: appPath, role: 'orchestrator' }, owner)
    // A restart or reopen of a ticket session loads its conversation: the setting rides that too.
    await manager.create(
      { id: 'ticket-resumed', provider: 'claude', cwd: appPath, orchestrated: true, sessionId: 'earlier' },
      owner
    )
    const [chat, ticket, orchestrator, resumed] = read(record)
    const guard = commandGuardSettings(process.execPath, commandGuardFiles(appPath))
    assert.equal(chat?.method, 'session/new')
    assert.equal(resumed?.method, 'session/load')
    assert.deepEqual(settingsOf(chat), guard)
    for (const opened of [ticket, orchestrator, resumed]) {
      // Merged into the one settings object, never replacing the command guard's hooks.
      assert.deepEqual(settingsOf(opened), { ...guard, workflowKeywordTriggerEnabled: false })
    }
  } finally {
    manager.killAll()
  }
})

test('a ticket session with the command guard off still turns the keyword trigger off', async () => {
  const appPath = mkdtempSync(join(tmpdir(), 'toucan-keyword-trigger-unguarded-'))
  const { record } = openedSessions(appPath, 'claude-agent-acp')
  const manager = createAcpSessionManager({ appPath, environment: { PATH: process.env.PATH } })
  try {
    await manager.create(
      { id: 'ticket', provider: 'claude', cwd: appPath, orchestrated: true, commandGuard: false },
      owner
    )
    assert.deepEqual(settingsOf(read(record)[0]), { workflowKeywordTriggerEnabled: false })
  } finally {
    manager.killAll()
  }
})

test('a Codex ticket session carries no Claude settings', async () => {
  const appPath = mkdtempSync(join(tmpdir(), 'toucan-keyword-trigger-codex-'))
  const { record } = openedSessions(appPath, 'codex-acp')
  const manager = createAcpSessionManager({ appPath, environment: { PATH: process.env.PATH } })
  try {
    await manager.create({ id: 'ticket', provider: 'codex', cwd: appPath, orchestrated: true }, owner)
    assert.equal(settingsOf(read(record)[0]), undefined)
    assert.equal(read(record)[0]?.params._meta, undefined)
  } finally {
    manager.killAll()
  }
})

test('the switch keeps every setting already in the session object', () => {
  const configured = withWorkflowKeywordTriggerOff({
    _meta: { claudeCode: { options: { settings: { hooks: { PreToolUse: [] } }, disallowedTools: ['Edit'] } } }
  })
  assert.deepEqual(configured._meta?.claudeCode?.options, {
    settings: { hooks: { PreToolUse: [] }, workflowKeywordTriggerEnabled: false },
    disallowedTools: ['Edit']
  })
  assert.deepEqual(withWorkflowKeywordTriggerOff({})._meta?.claudeCode?.options, {
    settings: { workflowKeywordTriggerEnabled: false }
  })
})

test('a create request may carry orchestrated: true and nothing else', () => {
  const request = { id: 'ticket', provider: 'claude', cwd: '/work' }
  assert.equal(isAgentCreateRequest({ ...request, orchestrated: true }), true)
  assert.equal(isAgentCreateRequest(request), true)
  assert.equal(isAgentCreateRequest({ ...request, orchestrated: false }), false)
  assert.equal(isAgentCreateRequest({ ...request, orchestrated: 'yes' }), false)
})

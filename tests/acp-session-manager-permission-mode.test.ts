import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'
import type { WebContents } from 'electron'
import { createAcpSessionManager } from '../src/main/acp-session-manager'
import type { AgentCreateRequest } from '../src/shared/agent'
import { installScriptedAdapter, type AdapterPackage } from './helpers/scripted-adapter'

/**
 * The permission mode a session starts in. A fresh Claude session starts in Auto unless its caller
 * names a mode, whatever the adapter picked from the user's settings - starting in a remembered
 * Bypass without noticing is what this guards against. A resumed session keeps the mode its own
 * transcript carries, so nothing is forced onto a load.
 */

const owner = { isDestroyed: () => false, send: () => undefined } as unknown as WebContents

/**
 * An adapter that opens every session - new or loaded - in `startMode`, offers `modeIds`, and
 * appends each `session/set_mode` it is asked for to a file the test reads back. With `autoRunsAs`
 * it answers a request for Auto the way claude-agent-acp does on a model without Auto: it runs
 * that mode instead and reports it through `current_mode_update` before answering.
 */
function modeAdapter(
  appPath: string,
  adapter: AdapterPackage,
  startMode: string,
  modeIds: string[],
  autoRunsAs?: string
): string {
  const log = join(appPath, 'set-mode.log')
  installScriptedAdapter(appPath, adapter, {
    prelude: `
const fs = require('node:fs')
const modes = {
  currentModeId: ${JSON.stringify(startMode)},
  availableModes: ${JSON.stringify(modeIds)}.map((id) => ({ id, name: id }))
}`,
    handleRequest: `
  if (request.method === 'session/new') {
    send({ jsonrpc: '2.0', id: request.id, result: { sessionId: 'session-1', modes } })
  } else if (request.method === 'session/load') {
    send({ jsonrpc: '2.0', id: request.id, result: { modes } })
  } else if (request.method === 'session/set_mode') {
    fs.appendFileSync(${JSON.stringify(log)}, request.params.modeId + '\\n')
    const ran = request.params.modeId === 'auto' && ${JSON.stringify(autoRunsAs ?? null)}
    if (ran) {
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: { sessionId: request.params.sessionId, update: { sessionUpdate: 'current_mode_update', currentModeId: ran } }
      })
    }
    send({ jsonrpc: '2.0', id: request.id, result: {} })
  }`
  })
  return log
}

function setModeRequests(log: string): string[] {
  try {
    return readFileSync(log, 'utf8').split('\n').filter(Boolean)
  } catch {
    return []
  }
}

async function start(
  adapter: AdapterPackage,
  startMode: string,
  modeIds: string[],
  request: Partial<AgentCreateRequest> = {},
  autoRunsAs?: string
): Promise<{ currentModeId?: string; set: string[] }> {
  const appPath = mkdtempSync(join(tmpdir(), 'toucan-permission-mode-'))
  const log = modeAdapter(appPath, adapter, startMode, modeIds, autoRunsAs)
  const manager = createAcpSessionManager({ appPath, environment: { PATH: process.env.PATH } })
  try {
    const provider = adapter === 'codex-acp' ? 'codex' : 'claude'
    const created = await manager.create({ id: 'chat', provider, cwd: appPath, ...request }, owner)
    assert.equal(created.status, 'ready')
    return { currentModeId: created.modes?.currentModeId, set: setModeRequests(log) }
  } finally {
    manager.killAll()
  }
}

const CLAUDE_MODES = ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions']

test('a new Claude session starts in Auto even when the adapter opened it in Bypass', async () => {
  const started = await start('claude-agent-acp', 'bypassPermissions', CLAUDE_MODES)
  assert.deepEqual(started, { currentModeId: 'auto', set: ['auto'] })
})

test('a new Claude session already in Auto is left alone', async () => {
  const started = await start('claude-agent-acp', 'auto', CLAUDE_MODES)
  assert.deepEqual(started, { currentModeId: 'auto', set: [] })
})

test("a new Claude session starts in the mode its caller names, such as a ticket session's", async () => {
  const started = await start('claude-agent-acp', 'auto', CLAUDE_MODES, { permissionMode: 'acceptEdits' })
  assert.deepEqual(started, { currentModeId: 'acceptEdits', set: ['acceptEdits'] })
})

test('a new Claude session whose adapter offers no Auto keeps the adapter mode', async () => {
  const started = await start('claude-agent-acp', 'default', ['default', 'acceptEdits', 'plan'])
  assert.deepEqual(started, { currentModeId: 'default', set: [] })
})

test('a resumed session keeps the mode of its own transcript, even when a mode is named', async () => {
  const started = await start('claude-agent-acp', 'plan', CLAUDE_MODES, {
    sessionId: 'session-1',
    permissionMode: 'bypassPermissions'
  })
  assert.deepEqual(started, { currentModeId: 'plan', set: [] })
})

test('a new Codex session keeps the adapter default, which has no Auto mode', async () => {
  const started = await start('codex-acp', 'agent', ['read-only', 'agent', 'agent-full-access'])
  assert.deepEqual(started, { currentModeId: 'agent', set: [] })
})

test('a new Claude session the adapter opened in Manual stays in Manual, which is stricter than Auto', async () => {
  const started = await start('claude-agent-acp', 'default', CLAUDE_MODES)
  assert.deepEqual(started, { currentModeId: 'default', set: [] })
})

test('a session reports the mode the adapter actually runs, not the one it asked for', async () => {
  // claude-agent-acp runs Auto as Accept edits on a model without Auto, and says so.
  const started = await start('claude-agent-acp', 'plan', CLAUDE_MODES, {}, 'acceptEdits')
  assert.deepEqual(started, { currentModeId: 'acceptEdits', set: ['auto'] })
})

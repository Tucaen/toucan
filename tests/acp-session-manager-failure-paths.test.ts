import { strict as assert } from 'node:assert'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import type { WebContents } from 'electron'
import { createAcpSessionManager } from '../src/main/acp-session-manager'
import type { AgentEvent } from '../src/shared/agent'
import { AGENT_CHANNELS } from '../src/shared/ipc-channels'
import { installAdapterStub, installScriptedAdapter, stubAdapterChild } from './helpers/scripted-adapter'

/**
 * The failure paths of `src/main/acp-session-manager.ts` (issue #220), which the scripted-adapter
 * suites around it do not reach because each of them drives a happy path. What each behaviour is
 * for is in the code it locks down; these tests only pin that it holds.
 */

function collectingOwner(events: AgentEvent[]): WebContents {
  return {
    isDestroyed: () => false,
    send: (channel: string, payload: { event: AgentEvent }) => {
      if (channel === AGENT_CHANNELS.event) events.push(payload.event)
    }
  } as unknown as WebContents
}

function appWithAdapterStub(): string {
  const appPath = mkdtempSync(join(tmpdir(), 'toucan-acp-failure-'))
  installAdapterStub(appPath, 'codex-acp')
  return appPath
}

test("an adapter child that emits 'error' reports it and stops the session instead of crashing main", async () => {
  const events: AgentEvent[] = []
  let child: ChildProcessWithoutNullStreams | undefined
  const manager = createAcpSessionManager({
    appPath: appWithAdapterStub(),
    spawnAgent: () => {
      child = stubAdapterChild()
      return child
    }
  })

  try {
    // Never awaited: `create` is parked on the handshake, the window a spawn failure lands in.
    void manager.create({ id: 'doomed-node', provider: 'codex', cwd: '/project' }, collectingOwner(events))
    assert.ok(child)
    child.emit('error', new Error('spawn EMFILE'))
    await new Promise((resolve) => setImmediate(resolve))

    const error = events.find((event) => event.type === 'error')
    assert.ok(error && error.type === 'error', 'the failure must reach the node as an error event')
    assert.match(error.message, /EMFILE/)
    // Stopped, not left half-open: the session is out of the registry, so reopening the node
    // spawns a fresh adapter rather than prompting a dead one.
    const prompted = await manager.prompt('doomed-node', 'anyone there?')
    assert.equal(prompted.ok, false)
    assert.match(prompted.message ?? '', /not ready/i)
  } finally {
    manager.killAll()
  }
})

test('tool calls replayed by session/load do not stamp the session as a fresh writer of those files', async () => {
  const appPath = mkdtempSync(join(tmpdir(), 'toucan-replay-writes-'))
  installScriptedAdapter(appPath, 'claude-agent-acp', {
    handleRequest: `
  if (request.method === 'session/load') {
    send({ jsonrpc: '2.0', method: 'session/update', params: {
      sessionId: request.params.sessionId,
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'replayed-edit',
        title: 'Edit docs/tickets/old.md',
        kind: 'edit',
        status: 'completed',
        locations: [{ path: 'docs/tickets/old.md' }]
      }
    } })
    send({ jsonrpc: '2.0', id: request.id, result: {} })
    return
  }
  if (request.method === 'session/prompt') {
    send({ jsonrpc: '2.0', method: 'session/update', params: {
      sessionId: request.params.sessionId,
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'live-edit',
        title: 'Edit docs/tickets/new.md',
        kind: 'edit',
        status: 'completed',
        locations: [{ path: 'docs/tickets/new.md' }]
      }
    } })
    send({ jsonrpc: '2.0', id: request.id, result: { stopReason: 'end_turn' } })
  }`
  })
  const recorded: string[] = []
  const manager = createAcpSessionManager({
    appPath,
    sessionOutcomes: {
      watch: () => ({
        idle: async () => {},
        recordWrites: (paths: readonly string[]) => recorded.push(...paths),
        finalize: () => {}
      })
    } as never
  })

  try {
    const created = await manager.create(
      { id: 'resumed-node', provider: 'claude', cwd: appPath, sessionId: 'old-conversation' },
      collectingOwner([])
    )
    assert.equal(created.status, 'ready')

    assert.deepEqual(
      manager.recentWrites(),
      [],
      'a replayed write must not enter the attribution ring, whatever its age'
    )
    // The index is fed from replay on purpose; `recordWrittenLocations` says why.
    assert.deepEqual(recorded, [resolve(appPath, 'docs/tickets/old.md')])

    assert.equal((await manager.prompt('resumed-node', 'carry on')).ok, true)
    assert.deepEqual(
      manager.recentWrites().map((write) => write.path),
      [resolve(appPath, 'docs/tickets/new.md')],
      'a live write still lands in the ring'
    )
  } finally {
    manager.killAll()
  }
})

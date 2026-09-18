import { strict as assert } from 'node:assert'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { WebContents } from 'electron'
import { createAcpSessionManager } from '../src/main/acp-session-manager'
import type { AgentProcessLaunch } from '../src/main/agent-process'
import { installScriptedAdapter } from './helpers/scripted-adapter'

const owner = {
  isDestroyed: () => false,
  send: () => {}
} as unknown as WebContents

/**
 * Answers `session/fork` with a fixed child id, then replays the parent's history on the
 * `session/load` that follows. The load's first replay chunk carries what the adapter actually
 * received as JSON, so the test can assert the fork request's shape and the load's session id
 * without a side channel out of the child process.
 */
function forkingAdapter(appPath: string): void {
  installScriptedAdapter(appPath, 'claude-agent-acp', {
    agentCapabilities: { sessionCapabilities: { fork: {} } },
    prelude: `const observed = { fork: null }`,
    handleRequest: `
  if (request.method === 'session/fork') {
    observed.fork = request.params
    send({ jsonrpc: '2.0', id: request.id, result: { sessionId: 'forked-child' } })
    return
  }
  if (request.method === 'session/load') {
    const sessionId = request.params.sessionId
    send({ jsonrpc: '2.0', method: 'session/update', params: {
      sessionId,
      update: {
        sessionUpdate: 'user_message_chunk',
        messageId: 'observed-requests',
        content: { type: 'text', text: JSON.stringify({ fork: observed.fork, loadSessionId: sessionId }) }
      }
    } })
    send({ jsonrpc: '2.0', method: 'session/update', params: {
      sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'parent-answer',
        content: { type: 'text', text: 'Inherited answer' }
      }
    } })
    send({ jsonrpc: '2.0', id: request.id, result: {} })
  }`
  })
}

test('a fork launch issues session/fork then loads the id the fork returned', async () => {
  const appPath = mkdtempSync(join(tmpdir(), 'toucan-fork-adapter-'))
  forkingAdapter(appPath)
  const manager = createAcpSessionManager({ appPath })

  try {
    const result = await manager.create(
      {
        id: 'branched-node',
        provider: 'claude',
        cwd: appPath,
        forkFromSessionId: 'parent-session'
      },
      owner
    )

    assert.equal(result.status, 'ready')
    assert.equal(result.sessionId, 'forked-child')
    assert.equal(result.forkSupport, true)
    const observedText = result.replay?.find(
      (event) => event.type === 'message' && event.role === 'user'
    )
    assert.ok(observedText && observedText.type === 'message')
    const observed = JSON.parse(observedText.text) as {
      fork: { sessionId: string; cwd: string }
      loadSessionId: string
    }
    assert.equal(observed.fork.sessionId, 'parent-session')
    assert.equal(observed.fork.cwd, appPath)
    assert.equal(observed.loadSessionId, 'forked-child')
    // The child's full history rides the create result, like any resume.
    assert.ok(
      result.replay?.some(
        (event) => event.type === 'message' && event.role === 'assistant' && event.text === 'Inherited answer'
      )
    )
  } finally {
    manager.killAll()
  }
})

test('rejects a request naming both sessionId and forkFromSessionId before any process is spawned', async () => {
  const appPath = mkdtempSync(join(tmpdir(), 'toucan-fork-conflict-'))
  const spawns: AgentProcessLaunch[] = []
  const manager = createAcpSessionManager({
    appPath,
    spawnAgent: (launch) => {
      spawns.push(launch)
      throw new Error('a conflicting request must not spawn an adapter')
    }
  })

  const result = await manager.create(
    {
      id: 'conflicted-node',
      provider: 'claude',
      cwd: appPath,
      sessionId: 'saved-conversation',
      forkFromSessionId: 'parent-session'
    },
    owner
  )

  assert.equal(result.ok, false)
  assert.equal(result.status, 'error')
  assert.match(result.message ?? '', /forkFromSessionId/)
  assert.equal(result.sessionId, undefined)
  assert.equal(spawns.length, 0)
  manager.killAll()
})

test('a fork the adapter refuses surfaces as an error with the adapter message and no session', async () => {
  const appPath = mkdtempSync(join(tmpdir(), 'toucan-fork-failure-'))
  installScriptedAdapter(appPath, 'claude-agent-acp', {
    agentCapabilities: { sessionCapabilities: { fork: {} } },
    handleRequest: `
  if (request.method === 'session/fork') {
    send({ jsonrpc: '2.0', id: request.id, error: { code: -32602, message: 'Unknown parent session' } })
  }`
  })
  const manager = createAcpSessionManager({ appPath })

  try {
    const result = await manager.create(
      {
        id: 'orphan-branch',
        provider: 'claude',
        cwd: appPath,
        forkFromSessionId: 'no-such-session'
      },
      owner
    )

    assert.equal(result.ok, false)
    assert.equal(result.status, 'error')
    assert.match(result.message ?? '', /Unknown parent session/)
    assert.equal(result.sessionId, undefined)

    // Torn down like a failed load: nothing half-open lingers, so reopening the same node walks
    // the whole fork path again and meets the same refusal rather than a stale session.
    const reopened = await manager.create(
      {
        id: 'orphan-branch',
        provider: 'claude',
        cwd: appPath,
        forkFromSessionId: 'no-such-session'
      },
      owner
    )
    assert.equal(reopened.status, 'error')
    assert.match(reopened.message ?? '', /Unknown parent session/)
    assert.equal(reopened.sessionId, undefined)
  } finally {
    manager.killAll()
  }
})

test('reports forkSupport false when initialize advertised no session.fork capability', async () => {
  const appPath = mkdtempSync(join(tmpdir(), 'toucan-fork-unadvertised-'))
  installScriptedAdapter(appPath, 'claude-agent-acp', {
    handleRequest: `
  if (request.method === 'session/new') {
    send({ jsonrpc: '2.0', id: request.id, result: { sessionId: 'fresh-session' } })
  }`
  })
  const manager = createAcpSessionManager({ appPath })

  try {
    const result = await manager.create(
      { id: 'plain-node', provider: 'claude', cwd: appPath },
      owner
    )

    assert.equal(result.status, 'ready')
    assert.equal(result.forkSupport, false)
  } finally {
    manager.killAll()
  }
})

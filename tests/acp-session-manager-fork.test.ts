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
    const observedText = result.replay?.find((event) => event.type === 'message' && event.role === 'user')
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
    const result = await manager.create({ id: 'plain-node', provider: 'claude', cwd: appPath }, owner)

    assert.equal(result.status, 'ready')
    assert.equal(result.forkSupport, false)
  } finally {
    manager.killAll()
  }
})

test('a fork whose load fails is reopened by loading the child, never by forking the parent twice', async () => {
  // The auth-required shape of fork-then-load: `session/fork` copies the parent's transcript on
  // disk, and only then does `session/load` start the SDK query that needs an account. Recording
  // the child id after the load would leave `running.sessionId` unset, so the reopen would
  // evaluate `running.sessionId ?? fork(...)` again - two forked transcripts, the first orphaned,
  // and a node sitting on a different conversation id than the first attempt reported.
  const appPath = mkdtempSync(join(tmpdir(), 'toucan-fork-reauth-'))
  installScriptedAdapter(appPath, 'claude-agent-acp', {
    agentCapabilities: { sessionCapabilities: { fork: {} } },
    prelude: `let forks = 0
let loads = 0`,
    handleRequest: `
  if (request.method === 'session/fork') {
    forks += 1
    send({ jsonrpc: '2.0', id: request.id, result: { sessionId: 'forked-child-' + forks } })
    return
  }
  if (request.method === 'session/load') {
    loads += 1
    if (loads === 1) {
      send({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message: 'Authentication required' } })
      return
    }
    send({ jsonrpc: '2.0', method: 'session/update', params: {
      sessionId: request.params.sessionId,
      update: {
        sessionUpdate: 'user_message_chunk',
        messageId: 'observed-requests',
        content: { type: 'text', text: JSON.stringify({ forks, loads, loadSessionId: request.params.sessionId }) }
      }
    } })
    send({ jsonrpc: '2.0', id: request.id, result: {} })
  }`
  })
  const manager = createAcpSessionManager({ appPath })

  try {
    const request = {
      id: 'reauthed-branch',
      provider: 'claude' as const,
      cwd: appPath,
      forkFromSessionId: 'parent-session'
    }
    const first = await manager.create(request, owner)
    assert.equal(first.status, 'auth_required')

    // The very same node, reopened after the sign-in: the adapter process is still alive, so this
    // walks `openSession` again with the child id the first attempt already paid for.
    const reopened = await manager.create(request, owner)
    assert.equal(reopened.status, 'ready')
    assert.equal(reopened.sessionId, 'forked-child-1')

    const observedText = reopened.replay?.find((event) => event.type === 'message' && event.role === 'user')
    assert.ok(observedText && observedText.type === 'message')
    const observed = JSON.parse(observedText.text) as { forks: number; loads: number; loadSessionId: string }
    assert.equal(observed.forks, 1, 'two create calls on one forked node must issue exactly one session/fork')
    assert.equal(observed.loads, 2)
    assert.equal(observed.loadSessionId, 'forked-child-1')
  } finally {
    manager.killAll()
  }
})

test('a fork whose load fails for any other reason leaves nothing promptable behind', async () => {
  // The forked id is kept for the reopen, but it is a transcript on disk - not a session. Holding
  // it as `running.sessionId` would have `beginTurn` accept a prompt and issue `session/prompt`
  // against a conversation the adapter never loaded, which is why the two are separate fields.
  const appPath = mkdtempSync(join(tmpdir(), 'toucan-fork-load-failure-'))
  installScriptedAdapter(appPath, 'claude-agent-acp', {
    agentCapabilities: { sessionCapabilities: { fork: {} } },
    prelude: `let forks = 0`,
    handleRequest: `
  if (request.method === 'session/fork') {
    forks += 1
    send({ jsonrpc: '2.0', id: request.id, result: { sessionId: 'forked-child-' + forks } })
    return
  }
  if (request.method === 'session/load') {
    send({ jsonrpc: '2.0', id: request.id, error: { code: -32603, message: 'Transcript is corrupt' } })
    return
  }
  if (request.method === 'session/prompt') {
    send({ jsonrpc: '2.0', id: request.id, error: { code: -32602, message: 'no such session' } })
  }`
  })
  const manager = createAcpSessionManager({ appPath })

  try {
    const request = {
      id: 'unloadable-branch',
      provider: 'claude' as const,
      cwd: appPath,
      forkFromSessionId: 'parent-session'
    }
    const result = await manager.create(request, owner)
    assert.equal(result.status, 'error')
    assert.match(result.message ?? '', /Transcript is corrupt/)
    assert.equal(result.sessionId, undefined)

    const prompted = await manager.prompt('unloadable-branch', 'are you there?')
    assert.equal(prompted.ok, false)
    assert.match(prompted.message ?? '', /not ready/i)
  } finally {
    manager.killAll()
  }
})

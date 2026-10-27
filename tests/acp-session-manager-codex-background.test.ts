import { strict as assert } from 'node:assert'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'
import type { WebContents } from 'electron'
import { CODEX_SHELL_TASK_TYPE, codexShellReport, createAcpSessionManager } from '../src/main/acp-session-manager'
import { createAgentEventBroker } from '../src/main/agent-event-broker'
import type { AgentEvent } from '../src/shared/agent'
import { installScriptedAdapter, type AdapterPackage } from './helpers/scripted-adapter'

/**
 * codex-acp's shape for a backgrounded command (as a client that is not JetBrains AIR sees it): the
 * shell's tool call is still `in_progress` when the turn ends, and its completion arrives later as
 * a patch that carries only what changed. The prompt text picks the script.
 */
function codexShellAdapter(appPath: string, adapter: AdapterPackage = 'codex-acp'): void {
  installScriptedAdapter(appPath, adapter, {
    prelude: `
const sessionId = 'live-session'
const update = (u) => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: u } })
const shell = (toolCallId, status, extra = {}) =>
  update({ sessionUpdate: 'tool_call', toolCallId, title: 'npm run dev', kind: 'execute', status, _meta: { terminal_info: { cwd: '/p', terminal_id: toolCallId } }, ...extra })
const lateShell = (toolCallId) =>
  update({ sessionUpdate: 'tool_call_update', toolCallId, title: 'npm run dev', kind: 'execute', status: 'in_progress', content: [], _meta: { terminal_info: { cwd: '/p', terminal_id: toolCallId } } })
const finish = (id, status = 'completed') => ({ sessionUpdate: 'tool_call_update', toolCallId: id, status })
const done = (request, stopReason = 'end_turn') => send({ jsonrpc: '2.0', id: request.id, result: { stopReason } })
`,
    handleRequest: `
  if (request.method === 'session/new') return send({ jsonrpc: '2.0', id: request.id, result: { sessionId } })
  if (request.method === 'session/load') {
    // A replayed transcript: a command the old session once left in progress.
    shell('old', 'in_progress')
    return send({ jsonrpc: '2.0', id: request.id, result: {} })
  }
  if (request.method !== 'session/prompt') return
  const text = request.params.prompt[0].text
  if (text === 'background') {
    shell('fg', 'in_progress')
    update(finish('fg'))
    shell('dev', 'in_progress')
    update({ sessionUpdate: 'tool_call', toolCallId: 'read', title: 'Read', kind: 'read', status: 'in_progress' })
    done(request)
  } else if (text === 'two') {
    shell('a', 'in_progress')
    shell('b', 'pending')
    done(request)
  } else if (text === 'finish') {
    update(finish('dev'))
    done(request)
  } else if (text === 'exit') {
    update({ sessionUpdate: 'tool_call_update', toolCallId: 'dev', status: 'in_progress', _meta: { terminal_exit: { exit_code: 0, signal: null } } })
    done(request)
  } else if (text === 'cancel') {
    shell('x', 'in_progress')
    done(request, 'cancelled')
  } else if (text === 'fail') {
    shell('x', 'in_progress')
    send({ jsonrpc: '2.0', id: request.id, error: { code: -32603, message: 'boom' } })
  } else if (text === 'die') {
    done(request)
    setTimeout(() => process.exit(1), 30)
  } else if (text === 'late') {
    // The adapter released the call when the last turn ended; a late report carries every field.
    done(request)
    setTimeout(() => {
      lateShell('dev')
      lateShell('later')
    }, 30)
  } else {
    done(request)
  }`
  })
}

async function until<T>(get: () => T | undefined): Promise<T> {
  for (let attempt = 0; attempt < 300; attempt++) {
    const value = get()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('condition not reached')
}

const owner = { isDestroyed: () => false, send: () => {} } as unknown as WebContents

function open(adapter: AdapterPackage = 'codex-acp') {
  const appPath = mkdtempSync(join(tmpdir(), 'toucan-codex-background-'))
  codexShellAdapter(appPath, adapter)
  const broker = createAgentEventBroker()
  const events: AgentEvent[] = []
  broker.observe((_id, event) => events.push(event))
  const manager = createAcpSessionManager({ appPath, broker })
  const provider = adapter === 'codex-acp' ? 'codex' : 'claude'
  const counts = (): number[] =>
    events.flatMap((event) =>
      event.type === 'status' && event.backgroundTasks !== undefined ? [event.backgroundTasks] : []
    )
  const settled = (count: number) => () => (broker.snapshot('node-1')?.backgroundTasks === count ? true : undefined)
  return { appPath, broker, events, manager, provider, counts, settled }
}

test('a shell still open when the turn ends is a background task until its completion arrives', async () => {
  const { appPath, broker, events, manager, counts, settled } = open()
  try {
    await manager.create({ id: 'node-1', provider: 'codex', cwd: appPath }, owner)
    assert.deepEqual(manager.backgroundWork(), [])
    await manager.prompt('node-1', 'background')

    // Only the command left running counts: not the finished one, not a read.
    assert.deepEqual(manager.backgroundWork(), [{ id: 'node-1', tasks: 1, byType: { [CODEX_SHELL_TASK_TYPE]: 1 } }])
    assert.equal(broker.snapshot('node-1')?.backgroundTasks, 1)
    assert.equal(broker.snapshot('node-1')?.status, 'ready')
    // No wake follows a Codex background process, so the boundary does not promise one (a peer's
    // question would otherwise stay open for it); the count rides the live status alone.
    const boundary = events.find((event) => event.type === 'turn_complete')
    assert.ok(boundary && boundary.type === 'turn_complete' && boundary.backgroundTasks === undefined)

    // Its completion, in a turn that is not even about it: Idle again.
    await manager.prompt('node-1', 'finish')
    await until(settled(0))
    assert.deepEqual(manager.backgroundWork(), [])
    assert.deepEqual(counts(), [1, 0])
  } finally {
    manager.killAll()
  }
})

test('the count publishes once per change, whatever the number of reports', async () => {
  const { appPath, manager, counts } = open()
  try {
    await manager.create({ id: 'node-1', provider: 'codex', cwd: appPath }, owner)
    await manager.prompt('node-1', 'two')
    assert.deepEqual(manager.backgroundWork(), [{ id: 'node-1', tasks: 2, byType: { [CODEX_SHELL_TASK_TYPE]: 2 } }])
    // A second turn that settles nothing leaves the count, and the stream, alone.
    await manager.prompt('node-1', 'nothing')
    assert.deepEqual(counts(), [2])
  } finally {
    manager.killAll()
  }
})

test('a terminal that exits stops counting even while its tool call still reads in progress', async () => {
  const { appPath, manager, counts, settled } = open()
  try {
    await manager.create({ id: 'node-1', provider: 'codex', cwd: appPath }, owner)
    await manager.prompt('node-1', 'background')
    await manager.prompt('node-1', 'exit')
    await until(settled(0))
    assert.deepEqual(manager.backgroundWork(), [])
    assert.deepEqual(counts(), [1, 0])
  } finally {
    manager.killAll()
  }
})

test('a cancelled or failed turn counts none of its own open shells and keeps what earlier turns counted', async () => {
  const { appPath, manager, counts, settled } = open()
  try {
    await manager.create({ id: 'node-1', provider: 'codex', cwd: appPath }, owner)
    await manager.prompt('node-1', 'background')
    const failed = await manager.prompt('node-1', 'fail')
    assert.equal(failed.ok, false)
    assert.equal(manager.backgroundWork()[0]?.tasks, 1)

    // Stop interrupts the turn, not the background terminal an earlier turn left running.
    await manager.prompt('node-1', 'cancel')
    assert.deepEqual(manager.backgroundWork(), [{ id: 'node-1', tasks: 1, byType: { [CODEX_SHELL_TASK_TYPE]: 1 } }])

    // The cancelled and failed turns' own shells ('x') were never counted: only 'dev' ends the count.
    await manager.prompt('node-1', 'finish')
    await until(settled(0))
    assert.deepEqual(manager.backgroundWork(), [])
    assert.deepEqual(counts(), [1, 0])
  } finally {
    manager.killAll()
  }
})

test('late reports for released calls never open a turn, and a live one between turns counts at once', async () => {
  const { appPath, broker, events, manager, counts, settled } = open()
  try {
    await manager.create({ id: 'node-1', provider: 'codex', cwd: appPath }, owner)
    await manager.prompt('node-1', 'background')
    await manager.prompt('node-1', 'late')
    const afterPrompt = events.length

    // `dev` is already counted; `later` is a shell reporting live with no turn in flight.
    await until(settled(2))
    assert.deepEqual(manager.backgroundWork(), [{ id: 'node-1', tasks: 2, byType: { [CODEX_SHELL_TASK_TYPE]: 2 } }])
    assert.deepEqual(counts(), [1, 2])
    assert.equal(broker.snapshot('node-1')?.status, 'ready')
    const lateStatuses = events.slice(afterPrompt).flatMap((event) => (event.type === 'status' ? [event.status] : []))
    assert.deepEqual(lateStatuses, ['ready'])
  } finally {
    manager.killAll()
  }
})

test('a restored session starts at zero: replayed commands are history, never background work', async () => {
  const { appPath, broker, manager, counts } = open()
  try {
    const result = await manager.create(
      { id: 'node-1', provider: 'codex', cwd: appPath, sessionId: 'live-session' },
      owner
    )
    assert.ok(result.replay?.some((event) => event.type === 'activity' && event.activity.id === 'old'))
    assert.deepEqual(manager.backgroundWork(), [])

    // Nor does the next turn's end adopt a command it only saw replayed.
    await manager.prompt('node-1', 'nothing')
    assert.deepEqual(manager.backgroundWork(), [])
    assert.equal(broker.snapshot('node-1')?.backgroundTasks, 0)
    assert.deepEqual(counts(), [])
  } finally {
    manager.killAll()
  }
})

test('stopping the session drops the count, and a new adapter starts at zero', async () => {
  const { appPath, manager } = open()
  try {
    await manager.create({ id: 'node-1', provider: 'codex', cwd: appPath }, owner)
    await manager.prompt('node-1', 'background')
    assert.equal(manager.backgroundWork().length, 1)
    manager.kill('node-1')
    assert.deepEqual(manager.backgroundWork(), [])

    await manager.create({ id: 'node-1', provider: 'codex', cwd: appPath }, owner)
    assert.deepEqual(manager.backgroundWork(), [])
    await manager.prompt('node-1', 'nothing')
    assert.deepEqual(manager.backgroundWork(), [])
  } finally {
    manager.killAll()
  }
})

test('an adapter that exits takes its counted shells with it', async () => {
  const { appPath, manager } = open()
  try {
    await manager.create({ id: 'node-1', provider: 'codex', cwd: appPath }, owner)
    await manager.prompt('node-1', 'background')
    assert.equal(manager.backgroundWork().length, 1)
    await manager.prompt('node-1', 'die')
    await until(() => (manager.backgroundWork().length === 0 ? true : undefined))
  } finally {
    manager.killAll()
  }
})

test('Claude sessions are untouched: an open execute call is not a background task', async () => {
  const { appPath, manager, counts } = open('claude-agent-acp')
  try {
    await manager.create({ id: 'node-1', provider: 'claude', cwd: appPath }, owner)
    await manager.prompt('node-1', 'background')
    assert.deepEqual(manager.backgroundWork(), [])
    assert.deepEqual(counts(), [])
  } finally {
    manager.killAll()
  }
})

test('a tool call report is read as a shell by its kind or its terminal, and by id once followed', () => {
  assert.equal(codexShellReport({ sessionUpdate: 'tool_call', kind: 'execute', status: 'in_progress' }, false), 'live')
  assert.equal(codexShellReport({ sessionUpdate: 'tool_call', kind: 'execute' }, false), 'live')
  assert.equal(
    codexShellReport({ sessionUpdate: 'tool_call', status: 'pending', _meta: { terminal_info: {} } }, false),
    'live'
  )
  assert.equal(codexShellReport({ sessionUpdate: 'tool_call', kind: 'read', status: 'in_progress' }, false), null)
  assert.equal(codexShellReport({ sessionUpdate: 'tool_call_update', status: 'completed' }, false), null)
  // A patch without a kind is the shell it was opened as.
  assert.equal(codexShellReport({ sessionUpdate: 'tool_call_update', status: 'completed' }, true), 'settled')
  assert.equal(codexShellReport({ sessionUpdate: 'tool_call_update', status: 'failed' }, true), 'settled')
  assert.equal(
    codexShellReport(
      { sessionUpdate: 'tool_call_update', status: 'in_progress', _meta: { terminal_exit: { exit_code: 1 } } },
      true
    ),
    'settled'
  )
  // Output with no status says nothing about whether the command is still running.
  assert.equal(
    codexShellReport({ sessionUpdate: 'tool_call_update', _meta: { terminal_output: { data: 'x' } } }, true),
    null
  )
})

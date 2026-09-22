import { strict as assert } from 'node:assert'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'
import { applyRestoredTerminalLiveness, createTerminalLivenessStore } from '../src/main/terminal-liveness-store'
import type { WorkspaceState, WorkspaceTerminalNode } from '../src/shared/terminal'

function storePath(): string {
  return join(mkdtempSync(join(tmpdir(), 'toucan-liveness-')), 'terminal-liveness.json')
}

function terminalNode(overrides: Partial<WorkspaceTerminalNode> = {}): WorkspaceTerminalNode {
  return {
    id: 'node',
    sessionId: 'session',
    kind: 'terminal',
    label: 'Terminal 4',
    projectId: 'project',
    position: { x: 0, y: 0 },
    width: 400,
    height: 300,
    ...overrides
  }
}

function workspace(nodes: WorkspaceTerminalNode[]): WorkspaceState {
  return {
    version: 3,
    projects: [],
    activeProjectId: null,
    sidebarCollapsed: false,
    nodes,
    worktrees: []
  }
}

test('a kill recorded before quit is still readable after Toucan restarts', () => {
  const path = storePath()
  const before = createTerminalLivenessStore({ path, now: () => 100 })

  before.record('session', 'inc-1', 'live')
  before.record('session', 'inc-1', 'exited')

  // A separate instance is what the next launch gets: nothing carries over in memory.
  const after = createTerminalLivenessStore({ path, now: () => 200 })
  assert.deepEqual(after.read('session'), { incarnationId: 'inc-1', liveness: 'exited', at: 100 })
})

test('restores a killed terminal as exited and a crashed one as unverifiable', () => {
  const records = {
    killed: { incarnationId: 'inc-1', liveness: 'exited' as const, at: 1 },
    running: { incarnationId: 'inc-2', liveness: 'live' as const, at: 1 }
  }
  const state = workspace([
    terminalNode({ id: 'killed', sessionId: 'killed' }),
    terminalNode({ id: 'crashed', sessionId: 'running' }),
    terminalNode({ id: 'unknown', sessionId: 'absent' })
  ])

  const restored = applyRestoredTerminalLiveness(state, (sessionId) =>
    sessionId === 'killed' ? records.killed : sessionId === 'running' ? records.running : null
  )

  assert.equal(restored.nodes[0].terminalLiveness, 'exited')
  // The last record says the process was live and no exit was ever written: Toucan died
  // without killing it, so its fate genuinely is unknown.
  assert.equal(restored.nodes[1].terminalLiveness, 'unverifiable')
  assert.equal(restored.nodes[2].terminalLiveness, 'unverifiable')
})

test('leaves agent nodes alone because only plain terminals own a process verdict', () => {
  const state = workspace([terminalNode({ kind: 'claude', sessionId: 'session', terminalLiveness: undefined })])

  const restored = applyRestoredTerminalLiveness(state, () => ({
    incarnationId: 'inc-1',
    liveness: 'exited',
    at: 1
  }))

  assert.equal(restored.nodes[0].terminalLiveness, undefined)
})

test('a stale exited verdict never outranks a newer live incarnation of the same session', () => {
  const path = storePath()
  const store = createTerminalLivenessStore({ path, now: () => 100 })

  store.record('session', 'inc-1', 'exited')
  store.record('session', 'inc-2', 'live')

  assert.deepEqual(store.read('session'), { incarnationId: 'inc-2', liveness: 'live', at: 100 })
})

test('drops a record when its terminal node is removed', () => {
  const path = storePath()
  const store = createTerminalLivenessStore({ path, now: () => 100 })
  store.record('session', 'inc-1', 'exited')

  store.remove('session')

  assert.equal(store.read('session'), null)
  assert.equal(createTerminalLivenessStore({ path }).read('session'), null)
})

test('forgets verdicts past the retention window instead of reporting them forever', () => {
  const path = storePath()
  let clock = 100
  const store = createTerminalLivenessStore({ path, maxAgeMs: 1000, now: () => clock })
  store.record('session', 'inc-1', 'exited')

  clock = 1101
  assert.equal(store.read('session'), null)
})

test('a corrupt journal degrades to no verdict rather than failing the launch', () => {
  const path = storePath()
  writeFileSync(path, '{ not json', 'utf8')

  const store = createTerminalLivenessStore({ path })

  assert.equal(store.read('session'), null)
  store.record('session', 'inc-1', 'exited')
  assert.equal(store.read('session')?.liveness, 'exited')
})

import { strict as assert } from 'node:assert'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createWorkspaceStore, parseWorkspaceState } from '../src/main/workspace-store'
import type { WorkspaceState } from '../src/shared/terminal'

function makeState(marker: string): WorkspaceState {
  return {
    version: 3,
    projects: [{ id: 'project-1', name: marker, path: 'D:\\Development\\ADE', color: '#71a9ff' }],
    activeProjectId: 'project-1',
    sidebarCollapsed: false,
    nodes: [],
    worktrees: []
  }
}

test('loads a version 1 workspace as an empty version 3 canvas', () => {
  const migrated = parseWorkspaceState({
    version: 1,
    projects: [{ id: 'project-1', name: 'ADE', path: 'D:\\Development\\ADE', color: '#71a9ff' }],
    activeProjectId: 'project-1',
    sidebarCollapsed: true
  })

  assert.deepEqual(migrated, {
    version: 3,
    projects: [{ id: 'project-1', name: 'ADE', path: 'D:\\Development\\ADE', color: '#71a9ff' }],
    activeProjectId: 'project-1',
    sidebarCollapsed: true,
    nodes: [],
    worktrees: []
  })
})

test('migrates a version 2 workspace to an empty worktree set without losing its nodes', () => {
  const migrated = parseWorkspaceState({
    version: 2,
    projects: [{ id: 'project-1', name: 'ADE', path: 'D:\\Development\\ADE', color: '#71a9ff' }],
    activeProjectId: 'project-1',
    sidebarCollapsed: false,
    nodes: [{
      id: 'node-1',
      kind: 'codex',
      label: 'Codex 1',
      projectId: 'project-1',
      position: { x: 12, y: 34 },
      width: 520,
      height: 340
    }]
  })

  assert.equal(migrated?.version, 3)
  assert.deepEqual(migrated?.worktrees, [])
  assert.equal(migrated?.nodes.length, 1)
  assert.equal(migrated?.nodes[0].id, 'node-1')
  assert.equal(migrated?.nodes[0].worktreeId, undefined)
})

test('migrates the legacy worklog preference to per-node focus mode', () => {
  const migrated = parseWorkspaceState({
    version: 3,
    projects: [{ id: 'project-1', name: 'ADE', path: 'D:\\Development\\ADE', color: '#71a9ff' }],
    activeProjectId: 'project-1',
    sidebarCollapsed: false,
    nodes: [{
      id: 'node-1',
      kind: 'codex',
      label: 'Codex 1',
      projectId: 'project-1',
      position: { x: 0, y: 0 },
      width: 520,
      height: 340,
      worklogCollapsed: false
    }],
    worktrees: []
  })

  assert.equal(migrated?.nodes[0].focusMode, false)
  assert.equal('worklogCollapsed' in migrated!.nodes[0], false)
})

test('preserves recently closed session nodes in a version 3 workspace', () => {
  const closedNode = {
    id: 'closed-node-1',
    kind: 'codex',
    label: 'Codex 1',
    projectId: 'project-1',
    position: { x: 240, y: 180 },
    width: 520,
    height: 340,
    conversationId: 'conversation-1'
  }
  const parsed = parseWorkspaceState({
    ...makeState('ADE'),
    recentlyClosedNodes: [closedNode]
  })

  assert.deepEqual(parsed?.recentlyClosedNodes, [closedNode])
})

test('rejects malformed recently closed session records', () => {
  assert.equal(parseWorkspaceState({
    ...makeState('ADE'),
    recentlyClosedNodes: [{ id: 'missing-session-fields' }]
  }), null)
})

test('rejects a workspace whose worktree records are malformed', () => {
  const base = {
    version: 3,
    projects: [{ id: 'project-1', name: 'ADE', path: 'D:\\Development\\ADE', color: '#71a9ff' }],
    activeProjectId: 'project-1',
    sidebarCollapsed: false,
    nodes: []
  }

  assert.equal(parseWorkspaceState({ ...base, worktrees: [{ id: 'w1' }] }), null)
  assert.equal(parseWorkspaceState({ ...base }), null)
  assert.ok(parseWorkspaceState({
    ...base,
    worktrees: [{
      id: 'w1',
      projectId: 'project-1',
      branch: 'feature/login',
      path: 'D:\\Development\\ADE-worktrees\\feature-login',
      baseRef: 'main',
      createdAt: '2026-08-27T09:00:00.000Z',
      position: { x: 0, y: 0 },
      width: 360,
      height: 232
    }]
  }))
})

test('saves and loads a valid workspace through the store', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ade-workspace-test-'))
  const store = createWorkspaceStore(join(directory, 'workspace.json'))
  const state: WorkspaceState = {
    version: 3,
    projects: [{
      id: 'project-1',
      name: 'ADE',
      path: 'D:\\Development\\ADE',
      color: '#71a9ff',
      setupCommand: 'npm install'
    }],
    activeProjectId: 'project-1',
    sidebarCollapsed: false,
    agentPermissionModes: { claude: 'acceptEdits', codex: 'read-only' },
    nodes: [],
    recentlyClosedNodes: [{
      id: 'closed-node-1',
      kind: 'codex',
      label: 'Codex 1',
      projectId: 'project-1',
      position: { x: 240, y: 180 },
      width: 520,
      height: 340,
      conversationId: 'conversation-1'
    }],
    worktrees: [{
      id: 'worktree-1',
      projectId: 'project-1',
      branch: 'feature/login',
      path: 'D:\\Development\\ADE-worktrees\\feature-login',
      baseRef: 'main',
      createdAt: '2026-08-27T09:00:00.000Z',
      position: { x: 40, y: 80 },
      width: 360,
      height: 232
    }]
  }

  assert.deepEqual(await store.save(state), { ok: true })
  assert.deepEqual(await store.load(), { state, recovered: false, unrecoverable: false })
})

test('repairs UTF-8 text that an older workspace cached as Windows-1252', () => {
  const parsed = parseWorkspaceState({
    version: 2,
    projects: [{ id: 'project-1', name: 'ADE', path: 'D:\\Development\\ADE', color: '#71a9ff' }],
    activeProjectId: 'project-1',
    sidebarCollapsed: false,
    nodes: [{
      id: 'node-1',
      kind: 'codex',
      label: 'Codex 1',
      projectId: 'project-1',
      position: { x: 0, y: 0 },
      width: 520,
      height: 340,
      preview: {
        assistant: 'Session persistence is working\u00e2\u20ac\u201dthe preview is readable.',
        updatedAt: '2026-08-11T11:38:54.228Z'
      }
    }]
  })

  assert.equal(parsed?.nodes[0].preview?.assistant, 'Session persistence is working\u2014the preview is readable.')
})

test('rejects an invalid workspace without touching disk', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ade-workspace-test-'))
  const primaryPath = join(directory, 'workspace.json')
  const store = createWorkspaceStore(primaryPath)

  const result = await store.save({ not: 'a workspace' } as unknown as WorkspaceState)
  assert.equal(result.ok, false)
  assert.equal(existsSync(primaryPath), false)
})

test('a corrupt primary snapshot with no backup surfaces an unrecoverable load, never a silent empty state', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ade-workspace-test-'))
  const primaryPath = join(directory, 'workspace.json')
  writeFileSync(primaryPath, '{ this is not valid json', 'utf8')

  const store = createWorkspaceStore(primaryPath)
  const result = await store.load()

  assert.deepEqual(result, { state: null, recovered: false, unrecoverable: true })
  // The corrupt file is left in place for forensics; nothing silently overwrote it.
  assert.equal(readFileSync(primaryPath, 'utf8'), '{ this is not valid json')
})

test('a fresh install with no primary or backup on disk is not reported as unrecoverable', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ade-workspace-test-'))
  const primaryPath = join(directory, 'workspace.json')
  const store = createWorkspaceStore(primaryPath)

  const result = await store.load()

  assert.deepEqual(result, { state: null, recovered: false, unrecoverable: false })
})

test('a corrupt backup with no primary also surfaces an unrecoverable load', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ade-workspace-test-'))
  const primaryPath = join(directory, 'workspace.json')
  writeFileSync(`${primaryPath}.backup`, 'not json at all', 'utf8')

  const store = createWorkspaceStore(primaryPath)
  const result = await store.load()

  assert.deepEqual(result, { state: null, recovered: false, unrecoverable: true })
})

test('a save that completed before a crash leaves the previous snapshot recoverable as backup', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ade-workspace-test-'))
  const primaryPath = join(directory, 'workspace.json')
  const store = createWorkspaceStore(primaryPath)

  await store.save(makeState('first'))
  await store.save(makeState('second'))

  // Simulate a crash that happened after the primary->backup promotion rename but before the
  // temp->primary rename of a third save: the primary is gone, but the backup (the prior valid
  // "first" snapshot, promoted when "second" was saved) survives on disk.
  rmSync(primaryPath)

  const result = await store.load()
  assert.equal(result.recovered, true)
  assert.equal(result.state?.projects[0].name, 'first')

  // Loading also self-heals the primary so the app does not stay in recovered mode forever.
  const reload = await store.load()
  assert.deepEqual(reload, { state: result.state, recovered: false, unrecoverable: false })
})

test('recovers from the backup when the primary snapshot is corrupt', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ade-workspace-test-'))
  const primaryPath = join(directory, 'workspace.json')
  const store = createWorkspaceStore(primaryPath)

  await store.save(makeState('good'))
  await store.save(makeState('better'))
  writeFileSync(primaryPath, 'not json at all', 'utf8')

  const result = await store.load()
  assert.equal(result.recovered, true)
  assert.equal(result.state?.projects[0].name, 'good')
})

test('reports no recovery possible when both primary and backup are corrupt', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ade-workspace-test-'))
  const primaryPath = join(directory, 'workspace.json')
  const backupPath = `${primaryPath}.backup`
  writeFileSync(primaryPath, 'garbage', 'utf8')
  writeFileSync(backupPath, 'also garbage', 'utf8')

  const store = createWorkspaceStore(primaryPath)
  const result = await store.load()

  assert.deepEqual(result, { state: null, recovered: false, unrecoverable: true })
})

test('a leftover temp file from an interrupted write does not affect load', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ade-workspace-test-'))
  const primaryPath = join(directory, 'workspace.json')
  const store = createWorkspaceStore(primaryPath)

  await store.save(makeState('stable'))
  // Simulate a crash mid-write: a stray temp file exists but was never renamed onto the primary.
  writeFileSync(`${primaryPath}.tmp-abandoned`, '{ incomplete', 'utf8')

  const result = await store.load()
  assert.deepEqual(result, { state: makeState('stable'), recovered: false, unrecoverable: false })
})

test('concurrent saves are serialized and never interleave file contents', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ade-workspace-test-'))
  const primaryPath = join(directory, 'workspace.json')
  const store = createWorkspaceStore(primaryPath)

  const count = 20
  const results = await Promise.all(
    Array.from({ length: count }, (_, index) => store.save(makeState(`state-${index}`)))
  )

  assert.ok(results.every((result) => result.ok))

  // The file on disk must be exactly one complete, valid snapshot, never a torn mix of writes.
  const onDisk: unknown = JSON.parse(readFileSync(primaryPath, 'utf8'))
  const parsed = parseWorkspaceState(onDisk)
  assert.ok(parsed)
  assert.match(parsed!.projects[0].name, /^state-\d+$/)

  const loaded = await store.load()
  assert.deepEqual(loaded.state, parsed)
  assert.equal(loaded.recovered, false)
})

test('an invalid save in the middle of a concurrent batch does not corrupt later valid saves', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ade-workspace-test-'))
  const primaryPath = join(directory, 'workspace.json')
  const store = createWorkspaceStore(primaryPath)

  const [first, invalid, last] = await Promise.all([
    store.save(makeState('one')),
    store.save({ broken: true } as unknown as WorkspaceState),
    store.save(makeState('two'))
  ])

  assert.equal(first.ok, true)
  assert.equal(invalid.ok, false)
  assert.equal(last.ok, true)

  const loaded = await store.load()
  assert.equal(loaded.state?.projects[0].name, 'two')
  assert.equal(loaded.recovered, false)
})

test('a save that fails while replacing the primary does not leak its temp file', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ade-workspace-test-'))
  const primaryPath = join(directory, 'workspace.json')
  // A directory at the primary path makes the final rename fail after the temp file is written.
  mkdirSync(primaryPath)
  const store = createWorkspaceStore(primaryPath)

  const result = await store.save(makeState('one'))
  assert.equal(result.ok, false)

  const leftoverTempFiles = readdirSync(directory).filter((name) => name.includes('.tmp-'))
  assert.deepEqual(leftoverTempFiles, [])
})

test('an unsent composer draft round-trips through the store, so it survives an ADE restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ade-workspace-test-'))
  const store = createWorkspaceStore(join(directory, 'workspace.json'))
  const state = makeState('drafts')
  state.nodes = [{
    id: 'node-1',
    kind: 'claude',
    label: 'Claude 1',
    projectId: 'project-1',
    position: { x: 0, y: 0 },
    width: 520,
    height: 340,
    draft: 'a half-written prompt\nsecond line'
  }]
  state.composerSendKey = 'mod-enter'

  assert.equal((await store.save(state)).ok, true)
  const loaded = await store.load()

  assert.equal(loaded.state?.nodes[0].draft, 'a half-written prompt\nsecond line')
  assert.equal(loaded.state?.composerSendKey, 'mod-enter')
})

test('rejects a workspace whose draft or send-key preference is the wrong shape', () => {
  const base = {
    version: 3,
    projects: [{ id: 'project-1', name: 'ADE', path: 'D:\Development\ADE', color: '#71a9ff' }],
    activeProjectId: 'project-1',
    sidebarCollapsed: false,
    nodes: [],
    worktrees: []
  }

  assert.equal(parseWorkspaceState({ ...base, composerSendKey: 'shift-enter' }), null)
  assert.equal(parseWorkspaceState({
    ...base,
    nodes: [{
      id: 'node-1',
      kind: 'claude',
      label: 'Claude 1',
      projectId: 'project-1',
      position: { x: 0, y: 0 },
      width: 520,
      height: 340,
      draft: 12
    }]
  }), null)
  assert.ok(parseWorkspaceState({ ...base, composerSendKey: 'enter' }))
})

import { strict as assert } from 'node:assert'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  CANVAS_NODE_VALIDATORS,
  createWorkspaceStore,
  isWorkspaceState,
  parseWorkspaceState
} from '../src/main/workspace-store'
import { CANVAS_NODE_KINDS } from '../src/renderer/src/canvas-workspace'
import { AGENT_TURN_OUTCOME_LIMIT } from '../src/shared/agent'
import type { WorkspaceState } from '../src/shared/terminal'

function makeState(marker: string): WorkspaceState {
  return {
    version: 3,
    projects: [{ id: 'project-1', name: marker, path: 'D:\\Development\\Toucan', color: '#71a9ff' }],
    activeProjectId: 'project-1',
    sidebarCollapsed: false,
    nodes: [],
    worktrees: []
  }
}

test('dictation cleanup remains opt-in and rejects models outside its fixed list', () => {
  assert.equal(parseWorkspaceState(makeState('old'))?.dictationCleanup, undefined)
  const state = { ...makeState('cleanup'), dictationCleanup: { enabled: true, claudeModelId: 'sonnet' } }
  assert.deepEqual(parseWorkspaceState(state)?.dictationCleanup, state.dictationCleanup)
  assert.equal(isWorkspaceState({ ...state, dictationCleanup: { enabled: true, claudeModelId: 'opus' } }), false)
})

test('loads a version 1 workspace as an empty version 3 canvas', () => {
  const migrated = parseWorkspaceState({
    version: 1,
    projects: [{ id: 'project-1', name: 'Toucan', path: 'D:\\Development\\Toucan', color: '#71a9ff' }],
    activeProjectId: 'project-1',
    sidebarCollapsed: true
  })

  assert.deepEqual(migrated, {
    version: 3,
    projects: [{ id: 'project-1', name: 'Toucan', path: 'D:\\Development\\Toucan', color: '#71a9ff' }],
    activeProjectId: 'project-1',
    sidebarCollapsed: true,
    nodes: [],
    worktrees: []
  })
})

test('migrates a version 2 workspace to an empty worktree set without losing its nodes', () => {
  const migrated = parseWorkspaceState({
    version: 2,
    projects: [{ id: 'project-1', name: 'Toucan', path: 'D:\\Development\\Toucan', color: '#71a9ff' }],
    activeProjectId: 'project-1',
    sidebarCollapsed: false,
    nodes: [
      {
        id: 'node-1',
        kind: 'codex',
        label: 'Codex 1',
        projectId: 'project-1',
        position: { x: 12, y: 34 },
        width: 520,
        height: 340
      }
    ]
  })

  assert.equal(migrated?.version, 3)
  assert.deepEqual(migrated?.worktrees, [])
  assert.equal(migrated?.nodes.length, 1)
  assert.equal(migrated?.nodes[0].id, 'node-1')
  assert.equal(migrated?.nodes[0].worktreeId, undefined)
  assert.equal(migrated?.nodes[0].focusMode, false)
})

test('migrates the legacy worklog preference to per-node focus mode', () => {
  const migrated = parseWorkspaceState({
    version: 3,
    projects: [{ id: 'project-1', name: 'Toucan', path: 'D:\\Development\\Toucan', color: '#71a9ff' }],
    activeProjectId: 'project-1',
    sidebarCollapsed: false,
    nodes: [
      {
        id: 'node-1',
        kind: 'codex',
        label: 'Codex 1',
        projectId: 'project-1',
        position: { x: 0, y: 0 },
        width: 520,
        height: 340,
        worklogCollapsed: false
      }
    ],
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
    ...makeState('Toucan'),
    recentlyClosedNodes: [closedNode]
  })

  assert.deepEqual(parsed?.recentlyClosedNodes, [closedNode])
})

test('rejects malformed recently closed session records', () => {
  assert.equal(
    parseWorkspaceState({
      ...makeState('Toucan'),
      recentlyClosedNodes: [{ id: 'missing-session-fields' }]
    }),
    null
  )
})

test('clamps a persisted closed-session stack to its ten newest entries', () => {
  const parsed = parseWorkspaceState({
    ...makeState('Toucan'),
    recentlyClosedNodes: Array.from({ length: 12 }, (_, index) => ({
      id: `closed-node-${index + 1}`,
      kind: 'codex',
      label: `Codex ${index + 1}`,
      projectId: 'project-1',
      position: { x: index, y: index },
      width: 520,
      height: 340,
      conversationId: `conversation-${index + 1}`
    }))
  })

  assert.deepEqual(
    parsed?.recentlyClosedNodes?.map((node) => node.id),
    Array.from({ length: 10 }, (_, index) => `closed-node-${index + 3}`)
  )
})

test('clamps persisted turn outcomes to the newest bounded history', () => {
  const parsed = parseWorkspaceState({
    ...makeState('Toucan'),
    nodes: [
      {
        id: 'node-1',
        kind: 'codex',
        label: 'Codex 1',
        projectId: 'project-1',
        position: { x: 0, y: 0 },
        width: 520,
        height: 340,
        turnOutcomes: Array.from({ length: AGENT_TURN_OUTCOME_LIMIT + 2 }, (_, index) => ({
          id: `turn-${index + 1}`,
          status: 'failed',
          message: `Failure ${index + 1}`
        }))
      }
    ]
  })

  assert.deepEqual(
    parsed?.nodes[0].turnOutcomes?.map((outcome) => outcome.id),
    Array.from({ length: AGENT_TURN_OUTCOME_LIMIT }, (_, index) => `turn-${index + 3}`)
  )
})

test('rejects a workspace whose worktree records are malformed', () => {
  const base = {
    version: 3,
    projects: [{ id: 'project-1', name: 'Toucan', path: 'D:\\Development\\Toucan', color: '#71a9ff' }],
    activeProjectId: 'project-1',
    sidebarCollapsed: false,
    nodes: []
  }

  assert.equal(parseWorkspaceState({ ...base, worktrees: [{ id: 'w1' }] }), null)
  assert.equal(parseWorkspaceState({ ...base }), null)
  assert.ok(
    parseWorkspaceState({
      ...base,
      worktrees: [
        {
          id: 'w1',
          projectId: 'project-1',
          branch: 'feature/login',
          path: 'D:\\Development\\Toucan-worktrees\\feature-login',
          baseRef: 'main',
          createdAt: '2026-08-27T09:00:00.000Z',
          position: { x: 0, y: 0 },
          width: 360,
          height: 232
        }
      ]
    })
  )
})

test('saves and loads a valid workspace through the store', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'toucan-workspace-test-'))
  const store = createWorkspaceStore(join(directory, 'workspace.json'))
  const state: WorkspaceState = {
    version: 3,
    projects: [
      {
        id: 'project-1',
        name: 'Toucan',
        path: 'D:\\Development\\Toucan',
        color: '#71a9ff',
        setupCommand: 'npm install'
      }
    ],
    activeProjectId: 'project-1',
    sidebarCollapsed: false,
    agentPermissionModes: { claude: 'acceptEdits', codex: 'read-only' },
    nodes: [],
    recentlyClosedNodes: [
      {
        id: 'closed-node-1',
        kind: 'codex',
        label: 'Codex 1',
        projectId: 'project-1',
        position: { x: 240, y: 180 },
        width: 520,
        height: 340,
        conversationId: 'conversation-1'
      }
    ],
    worktrees: [
      {
        id: 'worktree-1',
        projectId: 'project-1',
        branch: 'feature/login',
        path: 'D:\\Development\\Toucan-worktrees\\feature-login',
        baseRef: 'main',
        createdAt: '2026-08-27T09:00:00.000Z',
        position: { x: 40, y: 80 },
        width: 360,
        height: 232
      }
    ]
  }

  assert.deepEqual(await store.save(state), { ok: true })
  assert.deepEqual(await store.load(), { state, recovered: false, unrecoverable: false })
})

test('drops the conversation preview an older workspace cached on its nodes', () => {
  const parsed = parseWorkspaceState({
    version: 2,
    projects: [{ id: 'project-1', name: 'Toucan', path: 'D:\Development\Toucan', color: '#71a9ff' }],
    activeProjectId: 'project-1',
    sidebarCollapsed: false,
    nodes: [
      {
        id: 'node-1',
        kind: 'codex',
        label: 'Codex 1',
        projectId: 'project-1',
        position: { x: 0, y: 0 },
        width: 520,
        height: 340,
        preview: { assistant: 'Session persistence is working.', updatedAt: '2026-08-11T11:38:54.228Z' }
      }
    ]
  })

  assert.equal(parsed?.nodes.length, 1)
  assert.equal('preview' in (parsed!.nodes[0] as unknown as Record<string, unknown>), false)
})

test('rejects an invalid workspace without touching disk', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'toucan-workspace-test-'))
  const primaryPath = join(directory, 'workspace.json')
  const store = createWorkspaceStore(primaryPath)

  const result = await store.save({ not: 'a workspace' } as unknown as WorkspaceState)
  assert.equal(result.ok, false)
  assert.equal(existsSync(primaryPath), false)
})

test('a corrupt primary snapshot with no backup surfaces an unrecoverable load, never a silent empty state', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'toucan-workspace-test-'))
  const primaryPath = join(directory, 'workspace.json')
  writeFileSync(primaryPath, '{ this is not valid json', 'utf8')

  const store = createWorkspaceStore(primaryPath)
  const result = await store.load()

  assert.deepEqual(result, { state: null, recovered: false, unrecoverable: true })
  // The corrupt file is left in place for forensics; nothing silently overwrote it.
  assert.equal(readFileSync(primaryPath, 'utf8'), '{ this is not valid json')
})

test('a fresh install with no primary or backup on disk is not reported as unrecoverable', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'toucan-workspace-test-'))
  const primaryPath = join(directory, 'workspace.json')
  const store = createWorkspaceStore(primaryPath)

  const result = await store.load()

  assert.deepEqual(result, { state: null, recovered: false, unrecoverable: false })
})

test('a corrupt backup with no primary also surfaces an unrecoverable load', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'toucan-workspace-test-'))
  const primaryPath = join(directory, 'workspace.json')
  writeFileSync(`${primaryPath}.backup`, 'not json at all', 'utf8')

  const store = createWorkspaceStore(primaryPath)
  const result = await store.load()

  assert.deepEqual(result, { state: null, recovered: false, unrecoverable: true })
})

test('a save that completed before a crash leaves the previous snapshot recoverable as backup', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'toucan-workspace-test-'))
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
  const directory = mkdtempSync(join(tmpdir(), 'toucan-workspace-test-'))
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
  const directory = mkdtempSync(join(tmpdir(), 'toucan-workspace-test-'))
  const primaryPath = join(directory, 'workspace.json')
  const backupPath = `${primaryPath}.backup`
  writeFileSync(primaryPath, 'garbage', 'utf8')
  writeFileSync(backupPath, 'also garbage', 'utf8')

  const store = createWorkspaceStore(primaryPath)
  const result = await store.load()

  assert.deepEqual(result, { state: null, recovered: false, unrecoverable: true })
})

test('a leftover temp file from an interrupted write does not affect load', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'toucan-workspace-test-'))
  const primaryPath = join(directory, 'workspace.json')
  const store = createWorkspaceStore(primaryPath)

  await store.save(makeState('stable'))
  // Simulate a crash mid-write: a stray temp file exists but was never renamed onto the primary.
  writeFileSync(`${primaryPath}.tmp-abandoned`, '{ incomplete', 'utf8')

  const result = await store.load()
  assert.deepEqual(result, { state: makeState('stable'), recovered: false, unrecoverable: false })
})

test('concurrent saves are serialized and never interleave file contents', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'toucan-workspace-test-'))
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
  const directory = mkdtempSync(join(tmpdir(), 'toucan-workspace-test-'))
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
  const directory = mkdtempSync(join(tmpdir(), 'toucan-workspace-test-'))
  const primaryPath = join(directory, 'workspace.json')
  // A directory at the primary path makes the final rename fail after the temp file is written.
  mkdirSync(primaryPath)
  const store = createWorkspaceStore(primaryPath)

  const result = await store.save(makeState('one'))
  assert.equal(result.ok, false)

  const leftoverTempFiles = readdirSync(directory).filter((name) => name.includes('.tmp-'))
  assert.deepEqual(leftoverTempFiles, [])
})

test('an unsent composer draft round-trips through the store, so it survives an Toucan restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'toucan-workspace-test-'))
  const store = createWorkspaceStore(join(directory, 'workspace.json'))
  const state = makeState('drafts')
  state.nodes = [
    {
      id: 'node-1',
      kind: 'claude',
      label: 'Claude 1',
      projectId: 'project-1',
      position: { x: 0, y: 0 },
      width: 520,
      height: 340,
      draft: 'a half-written prompt\nsecond line'
    }
  ]
  state.composerSendKey = 'mod-enter'

  assert.equal((await store.save(state)).ok, true)
  const loaded = await store.load()

  assert.equal(loaded.state?.nodes[0].draft, 'a half-written prompt\nsecond line')
  assert.equal(loaded.state?.composerSendKey, 'mod-enter')
})

test('rejects a workspace whose draft or send-key preference is the wrong shape', () => {
  const base = {
    version: 3,
    projects: [{ id: 'project-1', name: 'Toucan', path: 'D:\Development\Toucan', color: '#71a9ff' }],
    activeProjectId: 'project-1',
    sidebarCollapsed: false,
    nodes: [],
    worktrees: []
  }

  assert.equal(parseWorkspaceState({ ...base, composerSendKey: 'shift-enter' }), null)
  assert.equal(
    parseWorkspaceState({
      ...base,
      nodes: [
        {
          id: 'node-1',
          kind: 'claude',
          label: 'Claude 1',
          projectId: 'project-1',
          position: { x: 0, y: 0 },
          width: 520,
          height: 340,
          draft: 12
        }
      ]
    }),
    null
  )
  assert.ok(parseWorkspaceState({ ...base, composerSendKey: 'enter' }))
})

test('the routine-delegation preference survives a restart, and absent means off (issue #178)', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'toucan-workspace-test-'))
  const store = createWorkspaceStore(join(directory, 'workspace.json'))
  const state = makeState('delegation')
  // Both providers' worker choices persist side by side (issue #179), so switching provider or
  // re-enabling finds what was picked before.
  state.routineDelegation = { enabled: true, codexWorkerModelId: 'gpt-5.6-luna', claudeWorkerModelId: 'haiku' }

  assert.equal((await store.save(state)).ok, true)
  const loaded = await store.load()
  assert.deepEqual(loaded.state?.routineDelegation, {
    enabled: true,
    codexWorkerModelId: 'gpt-5.6-luna',
    claudeWorkerModelId: 'haiku'
  })

  // A snapshot written before the preference existed simply has no field: existing workspaces
  // migrate with delegation off, and the loaded shape stays exactly what was saved.
  const before = makeState('pre-delegation')
  assert.equal((await store.save(before)).ok, true)
  assert.equal((await store.load()).state?.routineDelegation, undefined)
})

test('rejects a routine-delegation preference of the wrong shape', () => {
  const base = {
    version: 3,
    projects: [{ id: 'project-1', name: 'Toucan', path: 'D:\Development\Toucan', color: '#71a9ff' }],
    activeProjectId: 'project-1',
    sidebarCollapsed: false,
    nodes: [],
    worktrees: []
  }
  assert.equal(parseWorkspaceState({ ...base, routineDelegation: { enabled: 'yes' } }), null)
  assert.equal(parseWorkspaceState({ ...base, routineDelegation: 'on' }), null)
  assert.equal(parseWorkspaceState({ ...base, routineDelegation: { enabled: true, claudeWorkerModelId: 1 } }), null)
  assert.ok(parseWorkspaceState({ ...base, routineDelegation: { enabled: false } }))
})

test('the decision-delegation preference persists and is validated on its own (issue #213)', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'toucan-workspace-test-'))
  const store = createWorkspaceStore(join(directory, 'workspace.json'))
  const state = makeState('decisions')
  // Independent of routine delegation: one may be on without the other.
  state.decisionDelegation = { enabled: true }

  assert.equal((await store.save(state)).ok, true)
  const loaded = await store.load()
  assert.deepEqual(loaded.state?.decisionDelegation, { enabled: true })
  assert.equal(loaded.state?.routineDelegation, undefined)

  // Absent is the off state, so a workspace saved before the preference existed migrates by
  // doing nothing.
  assert.equal((await store.save(makeState('pre-decisions'))).ok, true)
  assert.equal((await store.load()).state?.decisionDelegation, undefined)
})

test('rejects a decision-delegation preference of the wrong shape', () => {
  const base = {
    version: 3,
    projects: [{ id: 'project-1', name: 'Toucan', path: 'D:\Development\Toucan', color: '#71a9ff' }],
    activeProjectId: 'project-1',
    sidebarCollapsed: false,
    nodes: [],
    worktrees: []
  }
  assert.equal(parseWorkspaceState({ ...base, decisionDelegation: { enabled: 'yes' } }), null)
  assert.equal(parseWorkspaceState({ ...base, decisionDelegation: 'on' }), null)
  assert.equal(parseWorkspaceState({ ...base, decisionDelegation: {} }), null)
  assert.ok(parseWorkspaceState({ ...base, decisionDelegation: { enabled: false } }))
})

test('unread attention records survive a restart, and stale ones are pruned on the way back in', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'toucan-workspace-test-'))
  const store = createWorkspaceStore(join(directory, 'workspace.json'))
  const state = makeState('attention')
  state.nodes = [
    {
      id: 'node-1',
      kind: 'claude',
      label: 'Claude 1',
      projectId: 'project-1',
      position: { x: 0, y: 0 },
      width: 520,
      height: 340
    }
  ]
  state.attention = [
    {
      id: 'node-1 approval perm-7',
      nodeId: 'node-1',
      kind: 'approval',
      key: 'perm-7',
      sourceId: 'claude-conversation',
      summary: 'Run command: npm test',
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
      events: 1,
      read: false
    },
    {
      // A node that was closed before the snapshot was written; nothing can ever clear this.
      id: 'gone result turn-a',
      nodeId: 'gone',
      kind: 'result',
      key: 'turn-a',
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
      events: 1,
      read: false
    }
  ]

  assert.equal((await store.save(state)).ok, true)
  const loaded = await store.load()

  assert.equal(loaded.state?.attention?.length, 1)
  assert.equal(loaded.state?.attention?.[0].nodeId, 'node-1')
  assert.equal(loaded.state?.attention?.[0].read, false)
  assert.equal(loaded.state?.attention?.[0].sourceId, 'claude-conversation')
})

test('rejects a workspace whose attention records are malformed', () => {
  const base = makeState('attention')

  assert.equal(parseWorkspaceState({ ...base, attention: [{ id: 'x', nodeId: 'node-1' }] }), null)
  assert.equal(
    parseWorkspaceState({
      ...base,
      attention: [
        {
          id: 'node-1 shouting perm-7',
          nodeId: 'node-1',
          kind: 'shouting',
          key: 'perm-7',
          createdAt: 1,
          updatedAt: 1,
          events: 1,
          read: false
        }
      ]
    }),
    null
  )
  assert.equal(parseWorkspaceState({ ...base, attention: {} }), null)
})

test('substitutes a palette colour for a malformed one rather than refusing the workspace', () => {
  const loaded = parseWorkspaceState({
    ...makeState('colours'),
    projects: [
      { id: 'project-1', name: 'One', path: 'D:\One', color: 'rebeccapurple' },
      { id: 'project-2', name: 'Two', path: 'D:\Two', color: '#71A9FF' },
      { id: 'project-3', name: 'Three', path: 'D:\Three', color: '#74d8a2' }
    ]
  })

  assert.deepEqual(
    loaded?.projects.map((project) => project.color),
    ['#71a9ff', '#e69a71', '#74d8a2']
  )
})

test('keeps project groups and prunes the memberships that name no group', () => {
  const loaded = parseWorkspaceState({
    ...makeState('groups'),
    projects: [
      { id: 'project-1', name: 'One', path: 'D:\One', color: '#71a9ff', groupId: 'group-1' },
      { id: 'project-2', name: 'Two', path: 'D:\Two', color: '#e69a71', groupId: 'ghost' }
    ],
    projectGroups: [
      { id: 'group-1', name: 'Work', collapsed: true },
      { id: 'group-1', name: 'Duplicate', collapsed: false }
    ]
  })

  assert.deepEqual(loaded?.projectGroups, [{ id: 'group-1', name: 'Work', collapsed: true }])
  assert.equal(loaded?.projects[0].groupId, 'group-1')
  assert.equal('groupId' in (loaded?.projects[1] ?? {}), false)
})

test('rejects a workspace whose project groups are malformed', () => {
  const base = makeState('groups')

  assert.equal(parseWorkspaceState({ ...base, projectGroups: {} }), null)
  assert.equal(parseWorkspaceState({ ...base, projectGroups: [{ id: 'group-1', name: 'Work' }] }), null)
  assert.equal(parseWorkspaceState({ ...base, projectGroups: [{ id: 'group-1', name: 7, collapsed: false }] }), null)
})

test('a snapshot written before groups existed loads unchanged', () => {
  const before = makeState('legacy')
  assert.deepEqual(parseWorkspaceState(before), before)
  assert.equal(parseWorkspaceState(before)?.projectGroups, undefined)
})

test('saves a workspace carrying project groups', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'toucan-groups-'))
  const path = join(directory, 'workspace.json')
  const store = createWorkspaceStore(path)
  const state: WorkspaceState = {
    ...makeState('groups'),
    projects: [{ id: 'project-1', name: 'One', path: 'D:\One', color: '#c992ff', groupId: 'group-1' }],
    projectGroups: [{ id: 'group-1', name: 'Work', collapsed: false }]
  }

  assert.equal((await store.save(state)).ok, true)
  const loaded = await store.load()
  assert.deepEqual(loaded.state, state)

  rmSync(directory, { recursive: true, force: true })
})

test('refuses to write a project colour that is not a stored #rrggbb', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'toucan-colour-'))
  const store = createWorkspaceStore(join(directory, 'workspace.json'))
  const state = makeState('colour')

  const result = await store.save({
    ...state,
    projects: [{ ...state.projects[0], color: 'red' }]
  })
  assert.equal(result.ok, false)

  rmSync(directory, { recursive: true, force: true })
})

test("a project's tickets folder override round-trips, and a non-string one is refused", async () => {
  const directory = mkdtempSync(join(tmpdir(), 'toucan-tickets-directory-'))
  const store = createWorkspaceStore(join(directory, 'workspace.json'))
  const state = makeState('tickets')
  const project = { ...state.projects[0], ticketsDirectory: 'notes/tickets' }

  assert.equal((await store.save({ ...state, projects: [project] })).ok, true)
  assert.equal((await store.load()).state?.projects[0].ticketsDirectory, 'notes/tickets')

  const refused = await store.save({
    ...state,
    projects: [{ ...project, ticketsDirectory: 7 as unknown as string }]
  })
  assert.equal(refused.ok, false)

  rmSync(directory, { recursive: true, force: true })
})

test('the ticket board panel round-trips, and a malformed one is refused rather than repaired', () => {
  const base = makeState('Toucan')

  const restored = parseWorkspaceState({ ...base, ticketBoardPanel: { open: true, width: 880 } })
  assert.deepEqual(restored?.ticketBoardPanel, { open: true, width: 880 })
  // A snapshot written before the board existed simply has no panel; it must still load.
  assert.equal(parseWorkspaceState(base)?.ticketBoardPanel, undefined)

  for (const panel of [{ open: true }, { open: 'yes', width: 880 }, { open: true, width: Number.NaN }, null, 'open']) {
    assert.equal(parseWorkspaceState({ ...base, ticketBoardPanel: panel }), null)
  }
})

test('layout slots round-trip, and a malformed slot is refused rather than repaired', () => {
  const base = makeState('Toucan')
  const slots = { '1': { 'node-1': { x: 16, y: 16, width: 476, height: 668 } }, '9': {} }

  assert.deepEqual(parseWorkspaceState({ ...base, layoutSlots: slots })?.layoutSlots, slots)
  // A snapshot written before slots existed simply has none; it must still load.
  assert.equal(parseWorkspaceState(base)?.layoutSlots, undefined)

  for (const malformed of [
    { '0': {} },
    { '1': null },
    { '1': { 'node-1': { x: 16, y: 16, width: 476 } } },
    { '1': { 'node-1': { x: Number.NaN, y: 16, width: 476, height: 668 } } },
    { '1': { 'node-1': { x: '16', y: 16, width: 476, height: 668 } } },
    []
  ]) {
    assert.equal(parseWorkspaceState({ ...base, layoutSlots: malformed }), null, JSON.stringify(malformed))
  }
})

test("a project's GitHub in-progress label round-trips, and a non-string one is refused", () => {
  const base = makeState('Toucan')
  const withLabel = { ...base, projects: [{ ...base.projects[0], githubInProgressLabel: 'doing' }] }
  assert.equal(parseWorkspaceState(withLabel)?.projects[0].githubInProgressLabel, 'doing')
  const refused = { ...base, projects: [{ ...base.projects[0], githubInProgressLabel: 3 }] }
  assert.equal(parseWorkspaceState(refused), null)
})

test("a project's run commands round-trip in order, and a malformed entry is refused", () => {
  const base = makeState('Toucan')
  const runCommands = [
    { id: 'api', name: 'API (watch)', command: 'dotnet watch run' },
    { id: 'web', name: 'Web', command: 'npm run dev' }
  ]

  const restored = parseWorkspaceState({ ...base, projects: [{ ...base.projects[0], runCommands }] })
  assert.deepEqual(restored?.projects[0].runCommands, runCommands)
  // A snapshot written before commands existed simply has none; it must still load.
  assert.equal(parseWorkspaceState(base)?.projects[0].runCommands, undefined)

  for (const malformed of [
    [{ id: 'api', name: 'API' }],
    [{ id: 1, name: 'API', command: 'x' }],
    [null],
    'npm run dev'
  ]) {
    assert.equal(
      parseWorkspaceState({ ...base, projects: [{ ...base.projects[0], runCommands: malformed }] }),
      null,
      JSON.stringify(malformed)
    )
  }
})

test('a project may name its own tickets folder, and the snapshot keeps it', () => {
  const base = makeState('Toucan')
  const withFolder = {
    ...base,
    projects: [{ ...base.projects[0], ticketsDirectory: 'notes/tickets' }]
  }
  assert.equal(parseWorkspaceState(withFolder)?.projects[0].ticketsDirectory, 'notes/tickets')
})

test('file nodes round-trip through the snapshot and malformed ones are refused', async () => {
  const base = makeState('Toucan')
  const file = {
    id: 'file-1',
    projectId: 'project-1',
    path: 'D:\\Development\\Toucan\\docs\\plan.md',
    view: 'rendered' as const,
    position: { x: 40, y: 60 },
    width: 480,
    height: 520
  }

  // A snapshot written before file nodes existed carries no `files` and still loads.
  assert.ok(parseWorkspaceState(base))
  assert.deepEqual(parseWorkspaceState({ ...base, files: [file] })?.files, [file])
  assert.equal(parseWorkspaceState({ ...base, files: [{ ...file, view: 'editing' }] }), null)
  assert.equal(parseWorkspaceState({ ...base, files: [{ ...file, path: 7 }] }), null)
  assert.equal(parseWorkspaceState({ ...base, files: 'nope' }), null)

  const directory = mkdtempSync(join(tmpdir(), 'toucan-workspace-files-'))
  try {
    const store = createWorkspaceStore(join(directory, 'workspace.json'))
    assert.deepEqual(await store.save({ ...base, files: [file] }), { ok: true })
    assert.deepEqual((await store.load()).state?.files, [file])
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('diff nodes round-trip through the snapshot and malformed ones are refused', async () => {
  const base = makeState('Toucan')
  const diff = {
    id: 'diff-1',
    projectId: 'project-1',
    worktreeId: 'worktree-1',
    position: { x: 40, y: 60 },
    width: 760,
    height: 560,
    selectedPath: 'src/a.ts'
  }
  const primary = { id: 'diff-2', projectId: 'project-1', position: { x: 0, y: 0 }, width: 700, height: 400 }

  // A snapshot written before diff nodes existed carries no `diffs` and still loads.
  assert.ok(parseWorkspaceState(base))
  assert.deepEqual(parseWorkspaceState({ ...base, diffs: [diff, primary] })?.diffs, [diff, primary])
  assert.equal(parseWorkspaceState({ ...base, diffs: [{ ...diff, worktreeId: 7 }] }), null)
  assert.equal(parseWorkspaceState({ ...base, diffs: [{ ...diff, selectedPath: [] }] }), null)
  assert.equal(parseWorkspaceState({ ...base, diffs: [{ ...diff, width: 'wide' }] }), null)
  assert.equal(parseWorkspaceState({ ...base, diffs: 'nope' }), null)

  const directory = mkdtempSync(join(tmpdir(), 'toucan-workspace-diffs-'))
  try {
    const store = createWorkspaceStore(join(directory, 'workspace.json'))
    assert.deepEqual(await store.save({ ...base, diffs: [diff, primary] }), { ok: true })
    assert.deepEqual((await store.load()).state?.diffs, [diff, primary])
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

/**
 * Issue #165: which array each canvas node kind persists into, and whether it may be absent, is
 * one table (`CANVAS_NODE_VALIDATORS`) rather than an `if` per kind. The two fields version 3 has
 * always had are required; a kind added later is absent from older snapshots and must stay optional.
 */
test('every canvas node kind is validated by its own entry, required fields included', () => {
  const base = makeState('Toucan')
  const { nodes: _nodes, ...withoutNodes } = base
  const { worktrees: _worktrees, ...withoutWorktrees } = base

  assert.equal(isWorkspaceState(withoutNodes), false)
  assert.equal(isWorkspaceState(withoutWorktrees), false)
  assert.equal(isWorkspaceState({ ...base, nodes: {} }), false)
  assert.equal(isWorkspaceState({ ...base, worktrees: [{ id: 'no-geometry' }] }), false)
  // The optional kinds are absent in every snapshot written before they existed.
  assert.equal(isWorkspaceState(base), true)
  assert.equal(isWorkspaceState({ ...base, files: [], diffs: [] }), true)
})

/**
 * The two tables sit on either side of the privilege seam, so nothing but this holds them
 * together: a kind persisted by the renderer with no validator entry would be written and never
 * checked, and one validated with no renderer entry would never be written at all.
 */
test('the validator table names the same fields, on the same terms, as the canvas node table', () => {
  // Compared as sets: the canvas table's order is the order nodes are laid on the canvas, which
  // means nothing to validation.
  const terms = (kinds: readonly { field: string; alwaysPersisted: boolean }[]): string[] =>
    kinds.map((kind) => `${kind.field}:${kind.alwaysPersisted}`).sort()

  assert.deepEqual(terms(CANVAS_NODE_VALIDATORS), terms(CANVAS_NODE_KINDS))
})

test("a branch's provenance round-trips, and a malformed one is refused at the seam (issue #204)", async () => {
  const directory = mkdtempSync(join(tmpdir(), 'toucan-workspace-test-'))
  const store = createWorkspaceStore(join(directory, 'workspace.json'))
  const state = makeState('lineage')
  const child = {
    id: 'child-node',
    kind: 'claude' as const,
    label: 'Claude 2',
    projectId: 'project-1',
    position: { x: 600, y: 0 },
    width: 520,
    height: 340,
    conversationId: 'conversation-child',
    branchedFrom: { nodeId: 'parent-node', conversationId: 'conversation-parent' }
  }
  state.nodes = [child]

  assert.equal((await store.save(state)).ok, true)
  assert.deepEqual((await store.load()).state?.nodes[0].branchedFrom, {
    nodeId: 'parent-node',
    conversationId: 'conversation-parent'
  })

  // The conversation id in this record leaves the renderer again as `forkFromSessionId` on an
  // `agent:create`, so a half-shaped record must not survive the crossing.
  const base = {
    version: 3,
    projects: [{ id: 'project-1', name: 'Toucan', path: 'D:\Development\Toucan', color: '#71a9ff' }],
    activeProjectId: 'project-1',
    sidebarCollapsed: false,
    nodes: [],
    worktrees: []
  }
  assert.equal(parseWorkspaceState({ ...base, nodes: [{ ...child, branchedFrom: { nodeId: 'parent-node' } }] }), null)
  assert.equal(parseWorkspaceState({ ...base, nodes: [{ ...child, branchedFrom: 'parent-node' }] }), null)
  assert.ok(parseWorkspaceState({ ...base, nodes: [child] }))
})

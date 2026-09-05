import { strict as assert } from 'node:assert'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createWorkspaceStore, parseWorkspaceState } from '../src/main/workspace-store'
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

test('repairs UTF-8 text that an older workspace cached as Windows-1252', () => {
  const parsed = parseWorkspaceState({
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
        position: { x: 0, y: 0 },
        width: 520,
        height: 340,
        preview: {
          assistant: 'Session persistence is working\u00e2\u20ac\u201dthe preview is readable.',
          updatedAt: '2026-08-11T11:38:54.228Z'
        }
      }
    ]
  })

  assert.equal(parsed?.nodes[0].preview?.assistant, 'Session persistence is working\u2014the preview is readable.')
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

test("a project's GitHub in-progress label round-trips, and a non-string one is refused", () => {
  const base = makeState('Toucan')
  const withLabel = { ...base, projects: [{ ...base.projects[0], githubInProgressLabel: 'doing' }] }
  assert.equal(parseWorkspaceState(withLabel)?.projects[0].githubInProgressLabel, 'doing')
  const refused = { ...base, projects: [{ ...base.projects[0], githubInProgressLabel: 3 }] }
  assert.equal(parseWorkspaceState(refused), null)
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

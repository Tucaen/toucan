import { strict as assert } from 'node:assert'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createWorkspaceStore, parseWorkspaceState } from '../src/main/workspace-store'
import type { WorkspaceState } from '../src/shared/terminal'

test('loads a version 1 workspace as an empty version 2 canvas', () => {
  const migrated = parseWorkspaceState({
    version: 1,
    projects: [{ id: 'project-1', name: 'ADE', path: 'D:\\Development\\ADE', color: '#71a9ff' }],
    activeProjectId: 'project-1',
    sidebarCollapsed: true
  })

  assert.deepEqual(migrated, {
    version: 2,
    projects: [{ id: 'project-1', name: 'ADE', path: 'D:\\Development\\ADE', color: '#71a9ff' }],
    activeProjectId: 'project-1',
    sidebarCollapsed: true,
    nodes: []
  })
})

test('saves and loads a valid workspace through the store', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ade-workspace-test-'))
  const store = createWorkspaceStore(join(directory, 'workspace.json'))
  const state: WorkspaceState = {
    version: 2,
    projects: [{ id: 'project-1', name: 'ADE', path: 'D:\\Development\\ADE', color: '#71a9ff' }],
    activeProjectId: 'project-1',
    sidebarCollapsed: false,
    agentPermissionModes: { claude: 'acceptEdits', codex: 'read-only' },
    firstMate: {
      activeProvider: 'claude',
      captains: {
        codex: {
          conversationId: 'codex-firstmate-session',
          permissionMode: 'read-only',
          modelId: 'gpt-5',
          effortId: 'high',
          closedDecisionIds: ['alpha:storage']
        },
        claude: {
          conversationId: 'claude-firstmate-session',
          permissionMode: 'bypassPermissions',
          modelId: 'claude-opus'
        }
      },
      worklogCollapsed: true,
      panelWidth: 448,
      knownTaskIds: ['alpha'],
      closedTaskIds: ['alpha']
    },
    nodes: []
  }

  assert.deepEqual(store.save(state), { ok: true })
  assert.deepEqual(store.load(), state)
})

test('migrates the old singleton FirstMate captain into its selected provider tab', () => {
  const migrated = parseWorkspaceState({
    version: 2,
    projects: [{ id: 'project-1', name: 'ADE', path: 'D:\\Development\\ADE', color: '#71a9ff' }],
    activeProjectId: 'project-1',
    sidebarCollapsed: false,
    firstMate: {
      provider: 'claude',
      conversationId: 'legacy-claude-session',
      permissionMode: 'bypassPermissions',
      modelId: 'claude-opus',
      worklogCollapsed: true,
      panelWidth: 448
    },
    nodes: []
  })

  assert.deepEqual(migrated?.firstMate, {
    activeProvider: 'claude',
    captains: {
      claude: {
        conversationId: 'legacy-claude-session',
        permissionMode: 'bypassPermissions',
        modelId: 'claude-opus'
      }
    },
    worklogCollapsed: true,
    panelWidth: 448
  })
})

test('loads a saved tabbed captain without effort using the existing provider default', () => {
  const migrated = parseWorkspaceState({
    version: 2,
    projects: [{ id: 'project-1', name: 'ADE', path: 'D:\\Development\\ADE', color: '#71a9ff' }],
    activeProjectId: 'project-1',
    sidebarCollapsed: false,
    firstMate: {
      activeProvider: 'codex',
      captains: { codex: { conversationId: 'existing-session', modelId: 'gpt-5' } }
    },
    nodes: []
  })

  assert.deepEqual(migrated?.firstMate?.captains?.codex, {
    conversationId: 'existing-session', modelId: 'gpt-5'
  })
})

test('rejects ambiguous FirstMate state that mixes singleton and tabbed captain fields', () => {
  const workspace = {
    version: 2,
    projects: [{ id: 'project-1', name: 'ADE', path: 'D:\\Development\\ADE', color: '#71a9ff' }],
    activeProjectId: 'project-1',
    sidebarCollapsed: false,
    nodes: []
  }

  assert.equal(parseWorkspaceState({
    ...workspace,
    firstMate: { provider: 'claude', activeProvider: 'codex' }
  }), null)
})

test('rejects persisted FirstMate panel widths below the supported minimum', () => {
  const workspace = {
    version: 2,
    projects: [{ id: 'project-1', name: 'ADE', path: 'D:\\Development\\ADE', color: '#71a9ff' }],
    activeProjectId: 'project-1',
    sidebarCollapsed: false,
    nodes: []
  }

  assert.equal(parseWorkspaceState({ ...workspace, firstMate: { panelWidth: 299 } }), null)
  assert.notEqual(parseWorkspaceState({ ...workspace, firstMate: { panelWidth: 300 } }), null)
})

test('accepts a persisted FirstMate panel width beyond the old fixed 720px ceiling', () => {
  const workspace = {
    version: 2,
    projects: [{ id: 'project-1', name: 'ADE', path: 'D:\\Development\\ADE', color: '#71a9ff' }],
    activeProjectId: 'project-1',
    sidebarCollapsed: false,
    nodes: []
  }

  assert.notEqual(parseWorkspaceState({ ...workspace, firstMate: { panelWidth: 721 } }), null)
  assert.notEqual(parseWorkspaceState({ ...workspace, firstMate: { panelWidth: 2400 } }), null)
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

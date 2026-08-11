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
    nodes: []
  }

  assert.deepEqual(store.save(state), { ok: true })
  assert.deepEqual(store.load(), state)
})

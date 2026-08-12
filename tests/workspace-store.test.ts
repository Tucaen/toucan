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

import { strict as assert } from 'node:assert'
import { test } from 'vitest'
import type { WorkspaceState } from '../src/shared/terminal'
import { normalizeWorktreePath, worktreePathKey } from '../src/shared/worktree'
import { normalizeWorkspaceWorktrees } from '../src/shared/worktree-identity'

function state(): WorkspaceState {
  return {
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
        worktreeId: 'duplicate',
        activeWorktreeId: 'duplicate',
        position: { x: 0, y: 0 },
        width: 520,
        height: 340
      }
    ],
    recentlyClosedNodes: [
      {
        id: 'closed-1',
        kind: 'codex',
        label: 'Codex 2',
        projectId: 'project-1',
        worktreeId: 'duplicate',
        position: { x: 0, y: 0 },
        width: 520,
        height: 340
      }
    ],
    worktrees: [
      {
        id: 'kept',
        projectId: 'project-1',
        branch: 'feature/one',
        path: 'D:\\Development\\Toucan-worktrees\\feature-one',
        baseRef: 'main',
        createdAt: '2026-09-22T00:00:00.000Z',
        position: { x: 0, y: 0 },
        width: 360,
        height: 232
      },
      {
        id: 'duplicate',
        projectId: 'project-1',
        branch: 'feature/duplicate',
        path: 'd:/development/toucan-worktrees/feature-one/',
        baseRef: 'main',
        createdAt: '2026-09-22T00:01:00.000Z',
        position: { x: 400, y: 0 },
        width: 360,
        height: 232
      }
    ]
  }
}

test('worktree paths normalize UNC, drive roots and trailing separators', () => {
  assert.equal(normalizeWorktreePath('d:/Development/Toucan/'), 'D:\\Development\\Toucan')
  assert.equal(normalizeWorktreePath('d:/'), 'D:\\')
  assert.equal(normalizeWorktreePath('//Build/Share/Toucan/'), '\\\\Build\\Share\\Toucan')
  assert.equal(normalizeWorktreePath('/home/dev/toucan/'), '/home/dev/toucan')
})

test('worktree path keys use the shared path identity rule', () => {
  assert.equal(worktreePathKey('D:\\Development\\Toucan'), worktreePathKey('d:/development/toucan/'))
  assert.notEqual(worktreePathKey('/home/dev/Toucan'), worktreePathKey('/home/dev/toucan'))
})

test('workspace normalization keeps the first duplicate and remaps every alias', () => {
  const normalized = normalizeWorkspaceWorktrees(state())

  assert.equal(normalized.worktrees.length, 1)
  assert.equal(normalized.worktrees[0].id, 'kept')
  assert.equal(normalized.worktrees[0].path, 'D:\\Development\\Toucan-worktrees\\feature-one')
  assert.equal(normalized.nodes[0].worktreeId, 'kept')
  assert.equal(normalized.nodes[0].activeWorktreeId, 'kept')
  assert.equal(normalized.recentlyClosedNodes?.[0].worktreeId, 'kept')
})

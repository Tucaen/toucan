import { strict as assert } from 'node:assert'
import { test } from 'vitest'
import type { CanvasNode, TerminalNodeCallbacks } from '../src/renderer/src/canvas-workspace'
import { isWorktreeCanvasNode } from '../src/renderer/src/canvas-workspace'
import { applyAttachedNodeCounts } from '../src/renderer/src/worktree-attachment'
import type { AgentProvider } from '../src/shared/agent-provider'

const callbacks = {
  onStatusChange: () => {},
  onConversationId: () => {},
  onTitleChange: async () => true,
  onFocusModeChange: () => {},
  onDraftChange: () => {},
  onModelChange: () => {},
  onResume: () => {}
} satisfies TerminalNodeCallbacks

const WORKTREE_PATH = 'D:\\Development\\ADE-worktrees\\feature-thinking-final-presentation'

function sessionNode(
  id: string,
  overrides: {
    kind?: AgentProvider | 'terminal'
    worktreeId?: string
  } = {}
): CanvasNode {
  return {
    id,
    type: 'terminalNode',
    position: { x: 0, y: 0 },
    data: {
      kind: overrides.kind ?? 'codex',
      sessionId: id,
      terminalLiveness: 'live',
      label: 'Codex',
      projectId: 'project-1',
      projectName: 'ADE',
      projectPath: 'D:\\Development\\ADE',
      projectColor: '#fff',
      worktreeId: overrides.worktreeId,
      workingDirectory: 'D:\\Development\\ADE',
      focusMode: false,
      dormant: false,
      launchMode: 'resume',
      ...callbacks
    }
  }
}

function worktreeNode(worktreeId: string, attachedNodeCount = 0): CanvasNode {
  return {
    id: `worktree:${worktreeId}`,
    type: 'worktreeNode',
    position: { x: 0, y: 0 },
    data: {
      worktreeId,
      branch: 'feature/thinking-final-presentation',
      path: WORKTREE_PATH,
      baseRef: 'main',
      createdAt: '2026-09-03T00:00:00.000Z',
      projectId: 'project-1',
      projectName: 'ADE',
      projectPath: 'D:\\Development\\ADE',
      projectColor: '#fff',
      attachedNodeCount,
      onRemoveWorktree: () => {},
      onCreateNodeInWorktree: () => {},
      onRunSetupCommand: () => {},
      onOpenDiff: () => {}
    }
  }
}

test('the attached count a worktree shows is the number of nodes actually running in it', () => {
  // A diff node reviews the worktree without running anything in it, so it is never attached and
  // never blocks the worktree's removal (issue #144).
  const diffNode: CanvasNode = {
    id: 'diff-1',
    type: 'diffNode',
    position: { x: 0, y: 0 },
    data: {
      projectId: 'project-1',
      projectName: 'ADE',
      projectPath: 'D:\\Development\\ADE',
      projectColor: '#fff',
      worktreeId: 'worktree-1',
      label: 'feature/thinking-final-presentation',
      path: WORKTREE_PATH,
      baseRef: 'main',
      onSelectDiffPath: () => {}
    }
  }
  const nodes = [
    sessionNode('node-1', { worktreeId: 'worktree-1' }),
    sessionNode('node-2', { worktreeId: 'worktree-1' }),
    sessionNode('node-3'),
    diffNode,
    worktreeNode('worktree-1')
  ]

  const counted = applyAttachedNodeCounts(nodes, [
    { id: 'project-1', name: 'ADE', path: 'D:\\Development\\ADE', color: '#fff', setupCommand: 'npm install' }
  ])

  const worktree = counted.filter(isWorktreeCanvasNode)[0]
  assert.equal(worktree.data.attachedNodeCount, 2)
  assert.equal(worktree.data.setupCommand, 'npm install')
})

test('recounting nodes that have not changed keeps the same array, so the canvas does not churn', () => {
  const nodes = [sessionNode('node-1', { worktreeId: 'worktree-1' }), worktreeNode('worktree-1', 1)]

  assert.equal(
    applyAttachedNodeCounts(nodes, [{ id: 'project-1', name: 'ADE', path: 'D:\\Development\\ADE', color: '#fff' }]),
    nodes
  )
})

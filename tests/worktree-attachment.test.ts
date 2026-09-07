import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import type { CanvasNode, TerminalNodeCallbacks, TerminalNodeStatus } from '../src/renderer/src/canvas-workspace'
import { isTerminalCanvasNode, isWorktreeCanvasNode } from '../src/renderer/src/canvas-workspace'
import {
  applyAttachedNodeCounts,
  applyWorktreeClaims,
  adoptClaimedWorktrees,
  planWorktreeAdoptions
} from '../src/renderer/src/worktree-attachment'

const callbacks = {
  onStatusChange: () => {},
  onConversationId: () => {},
  onTitleChange: async () => true,
  onPreview: () => {},
  onFocusModeChange: () => {},
  onDraftChange: () => {},
  onPermissionModeChange: () => {},
  onModelChange: () => {},
  onResume: () => {}
} satisfies TerminalNodeCallbacks

const WORKTREE_PATH = 'D:\\Development\\ADE-worktrees\\feature-thinking-final-presentation'

function sessionNode(
  id: string,
  overrides: {
    kind?: 'claude' | 'codex' | 'terminal'
    worktreeId?: string
    activeWorktreeId?: string
    activeWorktreeBranch?: string
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
      activeWorktreeId: overrides.activeWorktreeId,
      activeWorktreeBranch: overrides.activeWorktreeBranch,
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

const statuses = (status: TerminalNodeStatus): Record<string, TerminalNodeStatus> => ({ 'node-1': status })

test('a Codex node that claimed a worktree is adopted into it once its turn is over', () => {
  const nodes = [sessionNode('node-1', { activeWorktreeId: 'worktree-1' }), worktreeNode('worktree-1')]

  assert.deepEqual(planWorktreeAdoptions(nodes, statuses('idle')), [
    {
      nodeId: 'node-1',
      worktreeId: 'worktree-1',
      branch: 'feature/thinking-final-presentation',
      path: WORKTREE_PATH
    }
  ])
})

test('adopting rehomes the node: the worktree becomes its own, and its working directory', () => {
  const nodes = [sessionNode('node-1', { activeWorktreeId: 'worktree-1' }), worktreeNode('worktree-1')]
  const adopted = adoptClaimedWorktrees(nodes, statuses('result'))
  const node = adopted.filter(isTerminalCanvasNode)[0]

  assert.equal(node.data.worktreeId, 'worktree-1')
  assert.equal(node.data.worktreeBranch, 'feature/thinking-final-presentation')
  assert.equal(node.data.workingDirectory, WORKTREE_PATH)
  assert.equal(node.data.launchMode, 'resume')
  // The weaker association is spent: leaving it would re-adopt the node on the next pass.
  assert.equal(node.data.activeWorktreeId, undefined)
  assert.equal(node.data.activeWorktreeBranch, undefined)
})

test('a node mid-turn keeps its association until the work it is doing is finished', () => {
  const nodes = [sessionNode('node-1', { activeWorktreeId: 'worktree-1' }), worktreeNode('worktree-1')]

  for (const status of ['working', 'starting', 'attention', 'stalled'] as const) {
    assert.deepEqual(planWorktreeAdoptions(nodes, statuses(status)), [], status)
    assert.equal(adoptClaimedWorktrees(nodes, statuses(status)), nodes, status)
  }
})

test('a node that has not reported a status yet is treated as still starting', () => {
  const nodes = [sessionNode('node-1', { activeWorktreeId: 'worktree-1' }), worktreeNode('worktree-1')]

  assert.deepEqual(planWorktreeAdoptions(nodes, {}), [])
})

test('a dormant node is adopted, so it comes back in the worktree rather than the checkout', () => {
  const nodes = [sessionNode('node-1', { activeWorktreeId: 'worktree-1' }), worktreeNode('worktree-1')]

  assert.equal(planWorktreeAdoptions(nodes, statuses('dormant')).length, 1)
})

test('Claude keeps the weaker association: its conversation cannot move directory', () => {
  const nodes = [sessionNode('node-1', { kind: 'claude', activeWorktreeId: 'worktree-1' }), worktreeNode('worktree-1')]

  assert.deepEqual(planWorktreeAdoptions(nodes, statuses('idle')), [])
})

test('a plain terminal is not an agent conversation and is never rehomed by a claim', () => {
  const nodes = [
    sessionNode('node-1', { kind: 'terminal', activeWorktreeId: 'worktree-1' }),
    worktreeNode('worktree-1')
  ]

  assert.deepEqual(planWorktreeAdoptions(nodes, statuses('idle')), [])
})

test('a node already attached to a worktree is left where it runs', () => {
  const nodes = [
    sessionNode('node-1', { worktreeId: 'worktree-2', activeWorktreeId: 'worktree-1' }),
    worktreeNode('worktree-1')
  ]

  assert.deepEqual(planWorktreeAdoptions(nodes, statuses('idle')), [])
})

test('an association whose worktree record is gone adopts nothing', () => {
  const nodes = [sessionNode('node-1', { activeWorktreeId: 'worktree-gone' })]

  assert.deepEqual(planWorktreeAdoptions(nodes, statuses('idle')), [])
})

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
    sessionNode('node-3', { activeWorktreeId: 'worktree-1' }),
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

test('a claim links the node that wrote it to the worktree, without moving it there', () => {
  const nodes = [sessionNode('node-1'), worktreeNode('worktree-1')]
  const linked = applyWorktreeClaims(nodes, [{ path: WORKTREE_PATH, nodeId: 'node-1' }])
  const node = linked.filter(isTerminalCanvasNode)[0]

  assert.equal(node.data.activeWorktreeId, 'worktree-1')
  assert.equal(node.data.activeWorktreeBranch, 'feature/thinking-final-presentation')
  assert.equal(node.data.worktreeId, undefined)
  assert.equal(node.data.workingDirectory, 'D:\\Development\\ADE')
})

test('a claim matches a worktree path in whatever slash and case shape it arrives', () => {
  const nodes = [sessionNode('node-1'), worktreeNode('worktree-1')]
  const linked = applyWorktreeClaims(nodes, [
    { path: 'd:/development/ade-worktrees/feature-thinking-final-presentation/', nodeId: 'node-1' }
  ])

  assert.equal(linked.filter(isTerminalCanvasNode)[0].data.activeWorktreeId, 'worktree-1')
})

test('a claim naming a node that already runs in a worktree changes nothing', () => {
  const nodes = [sessionNode('node-1', { worktreeId: 'worktree-2' }), worktreeNode('worktree-1')]

  assert.equal(applyWorktreeClaims(nodes, [{ path: WORKTREE_PATH, nodeId: 'node-1' }]), nodes)
})

test('a claim already applied is not applied again, so the canvas settles', () => {
  const nodes = [sessionNode('node-1', { activeWorktreeId: 'worktree-1' }), worktreeNode('worktree-1')]

  assert.equal(applyWorktreeClaims(nodes, [{ path: WORKTREE_PATH, nodeId: 'node-1' }]), nodes)
})

test('a claim for a path no worktree node records links nothing', () => {
  const nodes = [sessionNode('node-1'), worktreeNode('worktree-1')]

  assert.equal(applyWorktreeClaims(nodes, [{ path: 'D:\\elsewhere', nodeId: 'node-1' }]), nodes)
})

test('a stale claim cannot pull a node into another project\u2019s worktree', () => {
  const nodes = [
    sessionNode('node-1'),
    { ...worktreeNode('worktree-1'), data: { ...worktreeNode('worktree-1').data, projectId: 'project-2' } }
  ] as CanvasNode[]

  assert.equal(applyWorktreeClaims(nodes, [{ path: WORKTREE_PATH, nodeId: 'node-1' }]), nodes)
  assert.deepEqual(
    planWorktreeAdoptions([sessionNode('node-1', { activeWorktreeId: 'worktree-1' }), nodes[1]], statuses('idle')),
    []
  )
})

test('a node detached from a vanished worktree is never quietly rehomed by a claim', () => {
  const detached = sessionNode('node-1', { activeWorktreeId: 'worktree-1' })
  const nodes = [
    { ...detached, data: { ...detached.data, detachedFromWorktree: true } },
    worktreeNode('worktree-1')
  ] as CanvasNode[]

  assert.deepEqual(planWorktreeAdoptions(nodes, statuses('idle')), [])
})

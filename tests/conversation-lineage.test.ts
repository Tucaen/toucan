import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  restoreCanvasWorkspace,
  serializeCanvasNode,
  isTerminalCanvasNode,
  type CanvasNode,
  type TerminalCanvasNode,
  type TerminalNodeData
} from '../src/renderer/src/canvas-workspace'
import {
  branchBlockedReason,
  launchModeAfterConversation,
  lineageEdgeId,
  lineageEdges,
  lineageKey,
  offersBranchAction,
  planBranch
} from '../src/renderer/src/conversation-lineage'
import { isValidTerminalContextConnection } from '../src/renderer/src/terminal-context-edges'
import type { WorkspaceState, WorkspaceTerminalNode } from '../src/shared/terminal'

const callbacks = {
  onStatusChange: () => undefined,
  onConversationId: () => undefined,
  onTitleChange: async () => true,
  onFocusModeChange: () => undefined,
  onDraftChange: () => undefined,
  onPermissionModeChange: () => undefined,
  onModelChange: () => undefined,
  onResume: () => undefined,
  onRemoveWorktree: () => undefined,
  onCreateNodeInWorktree: () => undefined,
  onRunSetupCommand: () => undefined,
  onOpenDiff: () => undefined,
  onViewModeChange: () => undefined,
  onRequestFilePath: async () => null,
  onPathChange: () => undefined,
  onSelectDiffPath: () => undefined
}

function workspace(nodes: WorkspaceTerminalNode[]): WorkspaceState {
  return {
    version: 3,
    projects: [{ id: 'project-1', name: 'Toucan', path: 'D:\\Development\\Toucan', color: '#71a9ff' }],
    activeProjectId: 'project-1',
    sidebarCollapsed: false,
    nodes,
    worktrees: []
  }
}

function chat(id: string, overrides: Partial<WorkspaceTerminalNode> = {}): WorkspaceTerminalNode {
  return {
    id,
    kind: 'claude',
    label: id,
    projectId: 'project-1',
    position: { x: 0, y: 0 },
    width: 750,
    height: 660,
    conversationId: `conversation-${id}`,
    ...overrides
  }
}

/** A parent chat, the child branched off it, and an unrelated Codex chat. */
function canvasNodes(): CanvasNode[] {
  return restoreCanvasWorkspace(
    workspace([
      chat('parent'),
      chat('child', { branchedFrom: { nodeId: 'parent', conversationId: 'conversation-parent' } }),
      chat('codex-chat', { kind: 'codex' })
    ]),
    callbacks
  ).nodes
}

function node(nodes: CanvasNode[], id: string): TerminalCanvasNode {
  const found = nodes.find((candidate) => candidate.id === id)
  assert.ok(found && isTerminalCanvasNode(found), `no session node ${id}`)
  return found
}

test('the Branch action is offered only for an allow-listed provider that reported the capability', () => {
  const nodes = canvasNodes()
  const withSupport = (id: string, forkSupport: boolean | undefined): { data: TerminalNodeData } => ({
    data: { ...node(nodes, id).data, forkSupport }
  })
  assert.equal(offersBranchAction(withSupport('parent', true)), true)
  // Unknown is permissive: a dormant or freshly restored node has no live session to ask, and a
  // fork runs in the child's adapter anyway.
  assert.equal(offersBranchAction(withSupport('parent', undefined)), true)
  // Reported missing is absent, not disabled.
  assert.equal(offersBranchAction(withSupport('parent', false)), false)
  // Codex is on the allow-list since its fork was verified live (#205).
  assert.equal(offersBranchAction(withSupport('codex-chat', true)), true)
  // The capability gate still applies to an allow-listed provider.
  assert.equal(offersBranchAction(withSupport('codex-chat', false)), false)
})

test('a node with no conversation, and a node that is not a chat, offer nothing to branch', () => {
  const nodes = restoreCanvasWorkspace(
    workspace([
      chat('fresh', { conversationId: undefined }),
      { ...chat('shell'), kind: 'terminal', sessionId: 'sh-1' }
    ]),
    callbacks
  ).nodes
  assert.equal(offersBranchAction(node(nodes, 'fresh')), false)
  assert.equal(offersBranchAction(node(nodes, 'shell')), false)
})

test('branching waits for a turn boundary and is free at every resting status', () => {
  for (const status of ['idle', 'result', 'dormant', 'exited'] as const) {
    assert.equal(branchBlockedReason(status), undefined, status)
  }
  for (const status of ['working', 'starting', 'attention', 'stalled'] as const) {
    assert.match(branchBlockedReason(status) ?? '', /turn/, status)
  }
})

test('the lineage edge is derived from the child, in its own id namespace', () => {
  const edges = lineageEdges(canvasNodes())
  assert.deepEqual(
    edges.map((edge) => [edge.id, edge.source, edge.target]),
    [[lineageEdgeId('parent', 'child'), 'parent', 'child']]
  )
  assert.equal(edges[0].deletable, false)
  assert.equal(edges[0].selectable, false)
  assert.notEqual(edges[0].className, undefined)
})

test('lineage survives a WorkspaceState round-trip', () => {
  const nodes = canvasNodes()
  const saved = nodes.filter(isTerminalCanvasNode).map(serializeCanvasNode)
  assert.deepEqual(saved.find((entry) => entry.id === 'child')?.branchedFrom, {
    nodeId: 'parent',
    conversationId: 'conversation-parent'
  })
  const restored = restoreCanvasWorkspace(workspace(saved), callbacks).nodes
  assert.deepEqual(
    lineageEdges(restored).map((edge) => edge.id),
    [lineageEdgeId('parent', 'child')]
  )
})

test('a removed parent drops the edge and keeps the provenance record on the child', () => {
  const nodes = canvasNodes().filter((candidate) => candidate.id !== 'parent')
  assert.deepEqual(lineageEdges(nodes), [])
  assert.deepEqual(node(nodes, 'child').data.branchedFrom, {
    nodeId: 'parent',
    conversationId: 'conversation-parent'
  })
})

test('lineage is not a connection: chat → chat is still refused', () => {
  const nodes = canvasNodes()
  assert.equal(isValidTerminalContextConnection(nodes, { source: 'parent', target: 'child' }), false)
  assert.equal(isValidTerminalContextConnection(nodes, { source: 'child', target: 'parent' }), false)
})

test('a branch relaunches as a fork until it owns a conversation, then resumes like any other', () => {
  const pending = restoreCanvasWorkspace(
    workspace([
      chat('parent'),
      chat('child', {
        conversationId: undefined,
        branchedFrom: { nodeId: 'parent', conversationId: 'conversation-parent' }
      })
    ]),
    callbacks
  ).nodes
  assert.equal(node(pending, 'child').data.launchMode, 'fork')
  assert.equal(node(canvasNodes(), 'child').data.launchMode, 'resume')
})

test('a branch inherits what the parent is running: its model, its worktree, its conversation', () => {
  const parent = node(canvasNodes(), 'parent')
  const running: TerminalCanvasNode = {
    ...parent,
    data: { ...parent.data, modelId: 'claude-opus-5[1m]', worktreeId: 'worktree-7' }
  }
  assert.deepEqual(planBranch(running), {
    kind: 'claude',
    branchedFrom: { nodeId: 'parent', conversationId: 'conversation-parent' },
    modelId: 'claude-opus-5[1m]',
    worktreeId: 'worktree-7'
  })

  // A parent that never reported a model leaves the child on the adapter's default, as a fresh
  // node is - not on some other model picked by accident.
  assert.equal(planBranch(node(canvasNodes(), 'parent'))?.modelId, undefined)

  // Nothing to fork: no plan at all.
  const fresh = restoreCanvasWorkspace(workspace([chat('fresh', { conversationId: undefined })]), callbacks).nodes
  assert.equal(planBranch(node(fresh, 'fresh')), undefined)
})

test('the lineage key ignores everything a drag changes and notices everything lineage depends on', () => {
  const nodes = canvasNodes()
  const dragged = nodes.map((candidate) =>
    candidate.id === 'parent' ? { ...candidate, position: { x: 900, y: 40 } } : candidate
  )
  assert.equal(lineageKey(dragged), lineageKey(nodes))
  assert.notEqual(lineageKey(nodes.filter((candidate) => candidate.id !== 'parent')), lineageKey(nodes))
})

test('a fork settles into a resume once the child owns a conversation, and nothing else moves', () => {
  // The bug this guards: a fork left standing would be replayed by the next restart of the node -
  // a terminal-context adoption, say - forking the parent again and losing the child's own turns.
  assert.equal(launchModeAfterConversation('fork'), 'resume')
  assert.equal(launchModeAfterConversation('new'), 'new')
  assert.equal(launchModeAfterConversation('resume'), 'resume')
})

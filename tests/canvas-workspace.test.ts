import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  isTerminalCanvasNode,
  isWorktreeCanvasNode,
  restoreCanvasWorkspace,
  serializeCanvasNode,
  serializeWorktreeNode,
  type CanvasNode,
  type TerminalCanvasNode,
  type WorktreeCanvasNode
} from '../src/renderer/src/canvas-workspace'
import type { WorkspaceState } from '../src/shared/terminal'

const callbacks = {
  onStatusChange: () => undefined,
  onConversationId: () => undefined,
  onPreview: () => undefined,
  onWorklogCollapsed: () => undefined,
  onDraftChange: () => undefined,
  onPermissionModeChange: () => undefined,
  onModelChange: () => undefined,
  onResume: () => undefined,
  onRemoveWorktree: () => undefined,
  onCreateNodeInWorktree: () => undefined,
  onRunSetupCommand: () => undefined
}

function terminalNodes(nodes: CanvasNode[]): TerminalCanvasNode[] {
  return nodes.filter(isTerminalCanvasNode)
}

function worktreeNodes(nodes: CanvasNode[]): WorktreeCanvasNode[] {
  return nodes.filter(isWorktreeCanvasNode)
}

test('restores saved canvas nodes and ignores nodes whose project is gone', () => {
  const state: WorkspaceState = {
    version: 3,
    projects: [{ id: 'project-1', name: 'ADE', path: 'D:\\Development\\ADE', color: '#71a9ff' }],
    activeProjectId: 'missing-project',
    sidebarCollapsed: false,
    agentPermissionModes: { codex: 'read-only' },
    nodes: [
      {
        id: 'node-1',
        kind: 'codex',
        label: 'Codex 7',
        projectId: 'project-1',
        position: { x: 30, y: 50 },
        width: 540,
        height: 360,
        conversationId: 'conversation-7',
        modelId: 'gpt-5-codex',
        worklogCollapsed: true
      },
      {
        id: 'orphan',
        kind: 'terminal',
        label: 'Terminal 8',
        projectId: 'deleted-project',
        position: { x: 0, y: 0 },
        width: 520,
        height: 340
      }
    ],
    worktrees: []
  }
  const restored = restoreCanvasWorkspace(state, callbacks)
  const nodes = terminalNodes(restored.nodes)

  assert.equal(nodes.length, 1)
  assert.equal(nodes[0].data.dormant, false)
  assert.equal(restored.statuses['node-1'], 'starting')
  assert.equal(nodes[0].data.projectPath, 'D:\\Development\\ADE')
  assert.equal(nodes[0].data.workingDirectory, 'D:\\Development\\ADE')
  assert.equal(nodes[0].data.worktreeId, undefined)
  assert.equal(nodes[0].data.worklogCollapsed, true)
  assert.equal(nodes[0].data.preferredPermissionMode, 'read-only')
  assert.equal(nodes[0].data.modelId, 'gpt-5-codex')
  assert.equal(restored.nextSessionNumber, 8)
  assert.equal(restored.activeProjectId, 'project-1')
  assert.deepEqual(serializeCanvasNode(nodes[0]), state.nodes[0])
})

test('keeps restored terminal processes dormant until explicitly opened', () => {
  const state: WorkspaceState = {
    version: 3,
    projects: [{ id: 'project-1', name: 'ADE', path: 'D:\\Development\\ADE', color: '#71a9ff' }],
    activeProjectId: 'project-1',
    sidebarCollapsed: false,
    nodes: [{
      id: 'terminal-1',
      sessionId: 'durable-terminal-session',
      kind: 'terminal',
      label: 'Terminal 1',
      projectId: 'project-1',
      position: { x: 0, y: 0 },
      width: 520,
      height: 340,
      terminalLiveness: 'live'
    }],
    worktrees: []
  }
  const restored = restoreCanvasWorkspace(state, callbacks)
  const node = terminalNodes(restored.nodes)[0]

  assert.equal(node.data.dormant, true)
  assert.equal(restored.statuses['terminal-1'], 'dormant')
  assert.equal(node.data.sessionId, 'durable-terminal-session')
  assert.equal(node.data.terminalLiveness, 'unverifiable')
})

test('starts legacy agent worklogs collapsed while preserving an explicit expanded choice', () => {
  const baseState: WorkspaceState = {
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
      height: 340
    }],
    worktrees: []
  }

  assert.equal(terminalNodes(restoreCanvasWorkspace(baseState, callbacks).nodes)[0].data.worklogCollapsed, true)

  baseState.nodes[0].worklogCollapsed = false
  const expanded = terminalNodes(restoreCanvasWorkspace(baseState, callbacks).nodes)[0]
  assert.equal(expanded.data.worklogCollapsed, false)
  assert.equal(serializeCanvasNode(expanded).worklogCollapsed, false)
})

const worktreeState = (): WorkspaceState => ({
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
  nodes: [
    {
      id: 'node-1',
      kind: 'claude',
      label: 'Claude Code 1',
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      position: { x: 400, y: 0 },
      width: 520,
      height: 340
    },
    {
      id: 'node-2',
      kind: 'terminal',
      label: 'Terminal 2',
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      position: { x: 400, y: 400 },
      width: 520,
      height: 340
    }
  ],
  worktrees: [{
    id: 'worktree-1',
    projectId: 'project-1',
    branch: 'feature/login',
    path: 'D:\\Development\\ADE-worktrees\\feature-login',
    baseRef: 'main',
    createdAt: '2026-08-27T09:00:00.000Z',
    position: { x: 0, y: 0 },
    width: 360,
    height: 232
  }]
})

test('an attached node runs in its worktree directory, not the project checkout', () => {
  const state = worktreeState()
  const restored = restoreCanvasWorkspace(state, callbacks)
  const node = terminalNodes(restored.nodes).find((candidate) => candidate.id === 'node-1')!

  assert.equal(node.data.workingDirectory, 'D:\\Development\\ADE-worktrees\\feature-login')
  assert.equal(node.data.projectPath, 'D:\\Development\\ADE')
  assert.equal(node.data.worktreeBranch, 'feature/login')
  assert.equal(node.data.detachedFromWorktree, false)
  assert.equal(serializeCanvasNode(node).worktreeId, 'worktree-1')
})

test('a restored worktree carries its attached node count and cannot be deleted from the canvas', () => {
  const state = worktreeState()
  const restored = restoreCanvasWorkspace(state, callbacks)
  const worktree = worktreeNodes(restored.nodes)[0]

  assert.equal(worktree.data.attachedNodeCount, 2)
  assert.equal(worktree.data.setupCommand, 'npm install')
  assert.equal(worktree.deletable, false)
  assert.deepEqual(serializeWorktreeNode(worktree), state.worktrees[0])
})

test('a worktree whose project is gone is dropped, and so is the attachment of its nodes', () => {
  const state = worktreeState()
  state.worktrees[0].projectId = 'deleted-project'
  const restored = restoreCanvasWorkspace(state, callbacks)

  assert.equal(worktreeNodes(restored.nodes).length, 0)
  for (const node of terminalNodes(restored.nodes)) {
    assert.equal(node.data.worktreeId, undefined)
    assert.equal(node.data.detachedFromWorktree, true)
  }
})

/**
 * The dangerous failure this guards against: a node silently reopening in the project
 * checkout and letting an agent edit the wrong tree.
 */
test('a node whose worktree record vanished restores detached and dormant', () => {
  const state = worktreeState()
  state.worktrees = []
  const restored = restoreCanvasWorkspace(state, callbacks)
  const node = terminalNodes(restored.nodes).find((candidate) => candidate.id === 'node-1')!

  assert.equal(node.data.detachedFromWorktree, true)
  assert.equal(node.data.dormant, true)
  assert.equal(restored.statuses['node-1'], 'dormant')
  assert.equal(node.data.workingDirectory, 'D:\\Development\\ADE')
  assert.equal(node.data.worktreeBranch, undefined)
  // The attachment is not silently re-persisted, so the record cannot come back to life.
  assert.equal(serializeCanvasNode(node).worktreeId, undefined)
})

import { strict as assert } from 'node:assert'
import { test } from 'vitest'
import {
  CREATE_NODE_ACTIONS,
  createNodeKeyAction,
  createSessionCanvasNode,
  isTerminalCanvasNode,
  restoreCanvasWorkspace,
  serializeCanvasNode
} from '../src/renderer/src/canvas-workspace'
import { parseWorkspaceState } from '../src/main/workspace-store'
import type { WorkspaceState, WorkspaceTerminalNode } from '../src/shared/workspace'

// #33: an orchestrator is a chat node with `role: 'orchestrator'`, created from the canvas context
// menu. The role is persisted with the node, and nothing but creation ever sets it.

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

const project = { id: 'project-1', name: 'Toucan', path: 'D:\\Development\\Toucan', color: '#71a9ff' }

function workspace(nodes: WorkspaceTerminalNode[]): WorkspaceState {
  return { version: 3, projects: [project], activeProjectId: project.id, sidebarCollapsed: false, nodes, worktrees: [] }
}

const savedChat = (overrides: Partial<WorkspaceTerminalNode> = {}): WorkspaceTerminalNode => ({
  id: 'orchestrator',
  kind: 'claude',
  label: 'Orchestrator 1',
  projectId: project.id,
  position: { x: 0, y: 0 },
  width: 750,
  height: 660,
  conversationId: 'conversation-1',
  ...overrides
})

test('the context menu offers New orchestrator, with a shortcut of its own', () => {
  const entry = CREATE_NODE_ACTIONS.find((candidate) => candidate.action === 'create-orchestrator')
  assert.equal(entry?.title, 'New orchestrator')
  assert.equal(
    createNodeKeyAction(
      { key: 'O', ctrlKey: true, shiftKey: true, altKey: false, metaKey: false, repeat: false },
      { editingTerminal: false }
    ),
    'create-orchestrator'
  )
})

test('the role is born with the node and survives a save and restore', () => {
  const created = createSessionCanvasNode(
    {
      id: 'orchestrator',
      kind: 'claude',
      label: 'Orchestrator 1',
      position: { x: 0, y: 0 },
      launchMode: 'new',
      role: 'orchestrator'
    },
    project,
    undefined,
    callbacks
  )
  assert.equal(created.data.role, 'orchestrator')

  const saved = serializeCanvasNode(created)
  assert.equal(saved.role, 'orchestrator')
  const restored = restoreCanvasWorkspace(workspace([saved]), callbacks).nodes.find(isTerminalCanvasNode)
  assert.equal(restored?.data.role, 'orchestrator')
})

test('an ordinary chat carries no role at all, and a terminal can never hold one', () => {
  const plain = createSessionCanvasNode(
    { id: 'plain', kind: 'claude', label: 'Claude 1', position: { x: 0, y: 0 }, launchMode: 'new' },
    project,
    undefined,
    callbacks
  )
  assert.equal('role' in serializeCanvasNode(plain), false)

  const terminal = createSessionCanvasNode(
    {
      id: 'shell',
      kind: 'terminal',
      label: 'Terminal 1',
      position: { x: 0, y: 0 },
      launchMode: 'new',
      role: 'orchestrator'
    },
    project,
    undefined,
    callbacks
  )
  assert.equal(terminal.data.role, undefined)
})

test('the store validates the role at the seam: only the orchestrator role, only on a chat', () => {
  assert.ok(parseWorkspaceState(workspace([savedChat({ role: 'orchestrator' })])))
  assert.ok(parseWorkspaceState(workspace([savedChat()])))
  assert.equal(parseWorkspaceState(workspace([savedChat({ role: 'admin' as never })])), null)
  assert.equal(parseWorkspaceState(workspace([savedChat({ kind: 'terminal', role: 'orchestrator' })])), null)
})

test('a ticket session opened in the background is born unselected, so it never takes the caret', () => {
  const seed = {
    id: 'ticket',
    kind: 'claude' as const,
    label: '#42',
    position: { x: 0, y: 0 },
    launchMode: 'new' as const
  }
  assert.equal(createSessionCanvasNode(seed, project, undefined, callbacks).selected, true)
  assert.equal(createSessionCanvasNode({ ...seed, background: true }, project, undefined, callbacks).selected, false)
})

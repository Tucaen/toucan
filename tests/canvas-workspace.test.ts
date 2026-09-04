import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  CLOSED_SESSION_STACK_LIMIT,
  closedSessionKeyAction,
  isTerminalCanvasNode,
  isWorktreeCanvasNode,
  rememberClosedSessionNodes,
  reopenClosedSession,
  restoreCanvasWorkspace,
  serializeCanvasNode,
  serializeWorktreeNode,
  cascadedNodePosition,
  type CanvasNode,
  type TerminalCanvasNode,
  type WorktreeCanvasNode
} from '../src/renderer/src/canvas-workspace'
import type { WorkspaceState } from '../src/shared/terminal'

const callbacks = {
  onStatusChange: () => undefined,
  onConversationId: () => undefined,
  onTitleChange: async () => true,
  onPreview: () => undefined,
  onFocusModeChange: () => undefined,
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
    projects: [{ id: 'project-1', name: 'Toucan', path: 'D:\\Development\\Toucan', color: '#71a9ff' }],
    activeProjectId: 'missing-project',
    sidebarCollapsed: false,
    agentPermissionModes: { codex: 'read-only' },
    nodes: [
      {
        id: 'node-1',
        kind: 'codex',
        label: 'Codex 7',
        titleSource: 'manual',
        projectId: 'project-1',
        position: { x: 30, y: 50 },
        width: 540,
        height: 360,
        conversationId: 'conversation-7',
        modelId: 'gpt-5-codex',
        turnOutcomes: [
          {
            id: 'failed-turn',
            status: 'failed',
            message: 'The provider connection closed before the turn completed.'
          }
        ],
        focusMode: true
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
  assert.equal(nodes[0].data.projectPath, 'D:\\Development\\Toucan')
  assert.equal(nodes[0].data.workingDirectory, 'D:\\Development\\Toucan')
  assert.equal(nodes[0].data.worktreeId, undefined)
  assert.equal(nodes[0].data.focusMode, true)
  assert.equal(nodes[0].data.preferredPermissionMode, 'read-only')
  assert.equal(nodes[0].data.modelId, 'gpt-5-codex')
  assert.deepEqual(nodes[0].data.turnOutcomes, state.nodes[0].turnOutcomes)
  assert.equal(nodes[0].data.titleSource, 'manual')
  assert.equal(nodes[0].dragHandle, '.node-header')
  assert.equal(restored.nextSessionNumber, 8)
  assert.equal(restored.activeProjectId, 'project-1')
  assert.deepEqual(serializeCanvasNode(nodes[0]), state.nodes[0])
})

test('restores every canvas node with its top bar as the only drag handle', () => {
  const nodes = restoreCanvasWorkspace(worktreeState(), callbacks).nodes

  assert.ok(nodes.length > 1)
  assert.ok(nodes.every((node) => node.dragHandle === '.node-header'))
})

test('keeps restored terminal processes dormant until explicitly opened', () => {
  const state: WorkspaceState = {
    version: 3,
    projects: [{ id: 'project-1', name: 'Toucan', path: 'D:\\Development\\Toucan', color: '#71a9ff' }],
    activeProjectId: 'project-1',
    sidebarCollapsed: false,
    nodes: [
      {
        id: 'terminal-1',
        sessionId: 'durable-terminal-session',
        kind: 'terminal',
        label: 'Terminal 1',
        projectId: 'project-1',
        position: { x: 0, y: 0 },
        width: 520,
        height: 340,
        terminalLiveness: 'live'
      }
    ],
    worktrees: []
  }
  const restored = restoreCanvasWorkspace(state, callbacks)
  const node = terminalNodes(restored.nodes)[0]

  assert.equal(node.data.dormant, true)
  assert.equal(restored.statuses['terminal-1'], 'dormant')
  assert.equal(node.data.sessionId, 'durable-terminal-session')
  assert.equal(node.data.terminalLiveness, 'unverifiable')
})

test('migrates the legacy worklog choice to focus mode and serializes only the new field', () => {
  const baseState: WorkspaceState = {
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
        height: 340
      }
    ],
    worktrees: []
  }

  assert.equal(terminalNodes(restoreCanvasWorkspace(baseState, callbacks).nodes)[0].data.focusMode, false)

  baseState.nodes[0].worklogCollapsed = false
  const restored = terminalNodes(restoreCanvasWorkspace(baseState, callbacks).nodes)[0]
  const serialized = serializeCanvasNode(restored)
  assert.equal(restored.data.focusMode, false)
  assert.equal(serialized.focusMode, false)
  assert.equal('worklogCollapsed' in serialized, false)
})

const worktreeState = (): WorkspaceState => ({
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
  worktrees: [
    {
      id: 'worktree-1',
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

test('an attached node runs in its worktree directory, not the project checkout', () => {
  const state = worktreeState()
  const restored = restoreCanvasWorkspace(state, callbacks)
  const node = terminalNodes(restored.nodes).find((candidate) => candidate.id === 'node-1')!

  assert.equal(node.data.workingDirectory, 'D:\\Development\\Toucan-worktrees\\feature-login')
  assert.equal(node.data.projectPath, 'D:\\Development\\Toucan')
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
  assert.equal(node.data.workingDirectory, 'D:\\Development\\Toucan')
  assert.equal(node.data.worktreeBranch, undefined)
  // The attachment is not silently re-persisted, so the record cannot come back to life.
  assert.equal(serializeCanvasNode(node).worktreeId, undefined)
})

test('remembering closed session nodes keeps the most recent bounded stack', () => {
  const state = worktreeState()
  state.nodes = Array.from({ length: CLOSED_SESSION_STACK_LIMIT + 2 }, (_, index) => ({
    id: `node-${index + 1}`,
    kind: 'codex' as const,
    label: `Codex ${index + 1}`,
    projectId: 'project-1',
    position: { x: index * 10, y: index * 20 },
    width: 520,
    height: 340,
    conversationId: `conversation-${index + 1}`,
    focusMode: true
  }))
  const restored = terminalNodes(restoreCanvasWorkspace(state, callbacks).nodes)

  const stack = restored.reduce(
    (current, node) => rememberClosedSessionNodes(current, [node]),
    [] as WorkspaceState['nodes']
  )

  assert.equal(stack.length, CLOSED_SESSION_STACK_LIMIT)
  assert.deepEqual(
    stack.map((node) => node.id),
    Array.from({ length: CLOSED_SESSION_STACK_LIMIT }, (_, index) => `node-${index + 3}`)
  )
  assert.deepEqual(stack.at(-1), state.nodes.at(-1))
})

test('a non-session close or an unresumable chat clears the shortcut target', () => {
  const state = worktreeState()
  const restored = restoreCanvasWorkspace(state, callbacks).nodes
  const stack = [state.nodes[0]]
  const worktree = worktreeNodes(restored)[0]
  const unresumableChat = terminalNodes(restored).find((node) => node.data.kind === 'claude')!

  assert.deepEqual(rememberClosedSessionNodes(stack, [worktree]), [])
  assert.deepEqual(rememberClosedSessionNodes(stack, [unresumableChat]), [])
})

test('the reopen shortcut falls through unless Ctrl+Shift+T can restore a session', () => {
  const key = (
    overrides: Partial<Parameters<typeof closedSessionKeyAction>[0]> = {}
  ): Parameters<typeof closedSessionKeyAction>[0] => ({
    key: 'T',
    ctrlKey: true,
    shiftKey: true,
    altKey: false,
    metaKey: false,
    ...overrides
  })

  assert.equal(closedSessionKeyAction(key(), true), 'reopen')
  assert.equal(closedSessionKeyAction(key(), false), 'none')
  assert.equal(closedSessionKeyAction(key({ ctrlKey: false }), true), 'none')
  assert.equal(closedSessionKeyAction(key({ altKey: true }), true), 'none')
  assert.equal(closedSessionKeyAction(key({ key: 'R' }), true), 'none')
})

test('reopening takes the newest closed session and resumes it at its saved position', () => {
  const state = worktreeState()
  state.agentPermissionModes = { codex: 'read-only' }
  const first = {
    ...state.nodes[0],
    conversationId: 'conversation-1'
  }
  const newest = {
    ...state.nodes[0],
    id: 'node-2',
    kind: 'codex' as const,
    label: 'Codex 2',
    conversationId: 'conversation-2',
    position: { x: 712, y: 438 }
  }

  const reopened = reopenClosedSession([first, newest], state, callbacks)

  assert.deepEqual(reopened.recentlyClosedNodes, [first])
  assert.equal(reopened.node?.id, 'node-2')
  assert.deepEqual(reopened.node?.position, { x: 712, y: 438 })
  assert.equal(reopened.node?.selected, true)
  assert.equal(reopened.node?.data.conversationId, 'conversation-2')
  assert.equal(reopened.node?.data.launchMode, 'resume')
  assert.equal(reopened.node?.data.dormant, false)
  assert.equal(reopened.node?.data.workingDirectory, 'D:\\Development\\Toucan-worktrees\\feature-login')
  assert.equal(reopened.node?.data.preferredPermissionMode, 'read-only')
})

test('a reopened session whose worktree vanished stays detached and dormant', () => {
  const state = worktreeState()
  const closedNode = { ...state.nodes[0], conversationId: 'conversation-1' }
  state.worktrees = []

  const reopened = reopenClosedSession([closedNode], state, callbacks)

  assert.equal(reopened.node?.data.detachedFromWorktree, true)
  assert.equal(reopened.node?.data.dormant, true)
  assert.equal(reopened.node?.data.workingDirectory, 'D:\\Development\\Toucan')
  assert.equal(reopened.node?.data.worktreeId, undefined)
})

test('an old closed-chat record without a conversation cannot reopen as a new one', () => {
  const state = worktreeState()
  const closedWithoutConversation = state.nodes[0]

  const reopened = reopenClosedSession([closedWithoutConversation], state, callbacks)

  assert.equal(reopened.node, null)
  assert.deepEqual(reopened.recentlyClosedNodes, [])
})

/**
 * A node created without a pointer - a phone spawning a chat - still needs somewhere to land, and
 * "somewhere" must not be exactly on top of the last one: a stacked node is invisible, which reads
 * to the user as a spawn that did not happen.
 */
test('a spawn position steps clear of whatever already occupies it', () => {
  const origin = { x: 100, y: 100 }

  assert.deepEqual(cascadedNodePosition([], origin), origin)
  assert.deepEqual(cascadedNodePosition([{ position: { x: 900, y: 900 } }], origin), origin)

  const first = cascadedNodePosition([{ position: origin }], origin)
  assert.notDeepEqual(first, origin)

  // Each occupied step pushes the candidate further, so a run of spawns fans out rather than
  // alternating between two spots.
  const second = cascadedNodePosition([{ position: origin }, { position: first }], origin)
  assert.notDeepEqual(second, origin)
  assert.notDeepEqual(second, first)
})

test('a canvas with no room left still yields a position rather than searching forever', () => {
  // Every step of the search is occupied; taking the last candidate anyway is a slight overlap,
  // which is a far smaller problem than a loop that does not end.
  const origin = { x: 0, y: 0 }
  const crowded = Array.from({ length: 200 }, (_, index) => ({ position: { x: index * 48, y: index * 48 } }))
  const position = cascadedNodePosition(crowded, origin)
  assert.equal(Number.isFinite(position.x), true)
  assert.equal(Number.isFinite(position.y), true)
})

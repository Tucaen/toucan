import { strict as assert } from 'node:assert'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  CANVAS_NODE_KINDS,
  canvasNodeKind,
  CLOSED_SESSION_STACK_LIMIT,
  closedSessionKeyAction,
  createNodeKeyAction,
  createWorktreeCanvasNode,
  NODE_SHORTCUT_LABELS,
  serializeCanvasNodes,
  sessionNodeStatus,
  withProjectColor,
  type ShortcutKey,
  isTerminalCanvasNode,
  isWorktreeCanvasNode,
  rememberClosedSessionNodes,
  reopenClosedSession,
  restoreCanvasWorkspace,
  serializeCanvasNode,
  serializeWorktreeNode,
  cascadedNodePosition,
  centredNodePosition,
  changeFileCanvasNodePath,
  createFileCanvasNode,
  createDiffCanvasNode,
  DEFAULT_DIFF_NODE_SIZE,
  DEFAULT_FILE_NODE_SIZE,
  DEFAULT_WORKTREE_SIZE,
  isChatCanvasNode,
  isDiffCanvasNode,
  isFileCanvasNode,
  isLayoutCanvasNode,
  NEW_NODE_SIZE,
  NEW_SESSION_NODE_SIZE,
  selectDiffCanvasNodePath,
  serializeDiffNode,
  serializeFileNode,
  withoutWorktree,
  type CanvasNode,
  type DiffCanvasNode,
  type FileCanvasNode,
  type TerminalCanvasNode,
  type WorktreeCanvasNode
} from '../src/renderer/src/canvas-workspace'
import type { CanvasNodeStateField, WorkspaceState } from '../src/shared/terminal'

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
  onRunSetupCommand: () => undefined,
  onOpenDiff: () => undefined,
  onViewModeChange: () => undefined,
  onRequestFilePath: async () => null,
  onPathChange: () => undefined,
  onSelectDiffPath: () => undefined
}

function terminalNodes(nodes: CanvasNode[]): TerminalCanvasNode[] {
  return nodes.filter(isTerminalCanvasNode)
}

function worktreeNodes(nodes: CanvasNode[]): WorktreeCanvasNode[] {
  return nodes.filter(isWorktreeCanvasNode)
}

function fileNodes(nodes: CanvasNode[]): FileCanvasNode[] {
  return nodes.filter(isFileCanvasNode)
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

/**
 * Issue #165: the layout-vs-session rule used to be written twice - the caller filtered layout
 * nodes out of the removal and the callee wiped the stack for anything that was not a session -
 * so deleting the filter silently wiped the reopen stack on every closed file node. It now lives
 * here alone, which is why closing a file node together with a session still remembers the
 * session rather than either dropping it or clearing everything.
 */
test('closing a layout node keeps the reopen stack, whatever it is closed alongside', () => {
  const state = worktreeState()
  const restored = restoreCanvasWorkspace(state, callbacks).nodes
  const stack = [state.nodes[0]]
  const file = createFileCanvasNode(
    { id: 'file-1', path: 'D:\\Development\\Toucan\\README.md', position: { x: 0, y: 0 } },
    state.projects[0],
    callbacks
  )
  const diff = createDiffCanvasNode({ id: 'diff-1', position: { x: 0, y: 0 } }, state.projects[0], undefined, callbacks)
  const session = terminalNodes(restored).find((node) => node.data.kind === 'terminal')!

  assert.deepEqual(rememberClosedSessionNodes(stack, [file, diff]), stack)
  assert.deepEqual(
    rememberClosedSessionNodes(stack, [file, session]).map((node) => node.id),
    ['node-1', 'node-2']
  )
  // A worktree close still wipes it: what comes back could be pointing at a checkout that is gone.
  assert.deepEqual(rememberClosedSessionNodes(stack, [file, worktreeNodes(restored)[0]]), [])
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

test('each node type has a direct Ctrl shortcut that mirrors the context menu', () => {
  const key = (overrides: Partial<ShortcutKey> = {}): ShortcutKey => ({
    key: 'p',
    ctrlKey: true,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    ...overrides
  })
  const canvas = { editingTerminal: false }

  assert.equal(createNodeKeyAction(key(), canvas), 'open-file')
  assert.equal(createNodeKeyAction(key({ key: 'P' }), canvas), 'open-file')
  assert.equal(createNodeKeyAction(key({ key: 't' }), canvas), 'create-terminal')
  assert.equal(createNodeKeyAction(key({ key: 'n' }), canvas), 'create-claude')
  assert.equal(createNodeKeyAction(key({ key: 'N', shiftKey: true }), canvas), 'create-codex')
  assert.equal(createNodeKeyAction(key({ key: 'h' }), canvas), 'open-history')
  assert.equal(createNodeKeyAction(key({ key: 'G', shiftKey: true }), canvas), 'create-worktree')
  // Shift changes the meaning, so a shifted key without a shifted binding does nothing.
  assert.equal(createNodeKeyAction(key({ key: 'P', shiftKey: true }), canvas), 'none')
  assert.equal(createNodeKeyAction(key({ key: 'g' }), canvas), 'none')
  // Ctrl+Shift+T stays the reopen shortcut.
  assert.equal(createNodeKeyAction(key({ key: 'T', shiftKey: true }), canvas), 'none')
  assert.equal(createNodeKeyAction(key({ ctrlKey: false }), canvas), 'none')
  assert.equal(createNodeKeyAction(key({ altKey: true }), canvas), 'none')
  assert.equal(createNodeKeyAction(key({ metaKey: true }), canvas), 'none')
  // A held key repeats; only the first press may create a node.
  assert.equal(createNodeKeyAction(key({ repeat: true }), canvas), 'none')
})

test('node shortcuts stay out of a focused terminal, where Ctrl+P, Ctrl+N, Ctrl+H and Ctrl+T are shell keys', () => {
  const key = (k: string, shiftKey = false): ShortcutKey => ({
    key: k,
    ctrlKey: true,
    shiftKey,
    altKey: false,
    metaKey: false
  })
  const terminal = { editingTerminal: true }
  assert.equal(createNodeKeyAction(key('p'), terminal), 'none')
  assert.equal(createNodeKeyAction(key('n'), terminal), 'none')
  assert.equal(createNodeKeyAction(key('h'), terminal), 'none')
  assert.equal(createNodeKeyAction(key('t'), terminal), 'none')
  assert.equal(createNodeKeyAction(key('N', true), terminal), 'none')
  assert.equal(createNodeKeyAction(key('G', true), terminal), 'none')
})

test('the menu hints are derived from the same bindings the handler reads', () => {
  assert.deepEqual(NODE_SHORTCUT_LABELS, {
    'create-terminal': 'Ctrl+T',
    'create-claude': 'Ctrl+N',
    'create-codex': 'Ctrl+Shift+N',
    'create-worktree': 'Ctrl+Shift+G',
    'open-history': 'Ctrl+H',
    'open-file': 'Ctrl+P',
    'open-diff': 'Ctrl+D'
  })
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

/**
 * A file node is layout, and layout must survive a restart even when the file it showed does
 * not: the node restores with its position and view mode and shows its not-found body itself.
 */
test('a file node survives save, load and restore with its position and view mode', () => {
  const state = worktreeState()
  state.files = [
    {
      id: 'file-1',
      projectId: 'project-1',
      path: 'D:\\Development\\Toucan\\docs\\plan.md',
      view: 'raw',
      position: { x: 900, y: 40 },
      width: 480,
      height: 560
    },
    {
      id: 'file-orphan',
      projectId: 'deleted-project',
      path: 'D:\\Elsewhere\\notes.md',
      view: 'rendered',
      position: { x: 0, y: 0 },
      width: 480,
      height: 560
    }
  ]
  const restored = restoreCanvasWorkspace(state, callbacks)
  const files = fileNodes(restored.nodes)

  assert.equal(files.length, 1)
  assert.equal(files[0].id, 'file-1')
  assert.equal(files[0].type, 'fileNode')
  assert.equal(files[0].dragHandle, '.node-header')
  assert.deepEqual(files[0].position, { x: 900, y: 40 })
  assert.equal(files[0].data.view, 'raw')
  assert.equal(files[0].data.path, 'D:\\Development\\Toucan\\docs\\plan.md')
  assert.equal(files[0].data.projectPath, 'D:\\Development\\Toucan')
  assert.equal(files[0].data.projectColor, '#71a9ff')
  assert.equal(files[0].data.onViewModeChange, callbacks.onViewModeChange)
  assert.deepEqual(serializeFileNode(files[0]), state.files[0])
  // The file's identity is not a session, so a closed file node is not a reopen target - and,
  // being layout rather than a session, it must not wipe the stack either.
  assert.deepEqual(rememberClosedSessionNodes([state.nodes[0]], [files[0]]), [state.nodes[0]])
})

test('a new file node opens Markdown rendered and everything else raw', () => {
  const project = worktreeState().projects[0]
  const markdown = createFileCanvasNode(
    { id: 'file-1', path: 'D:\\Development\\Toucan\\README.md', position: { x: 1, y: 2 } },
    project,
    callbacks
  )
  const source = createFileCanvasNode(
    { id: 'file-2', path: 'D:\\Development\\Toucan\\src\\index.ts', position: { x: 1, y: 2 } },
    project,
    callbacks
  )
  assert.equal(markdown.data.view, 'rendered')
  assert.equal(source.data.view, 'raw')
  assert.equal(markdown.data.projectId, project.id)
  assert.deepEqual(markdown.style, { width: DEFAULT_FILE_NODE_SIZE.width, height: DEFAULT_FILE_NODE_SIZE.height })
  assert.equal(serializeFileNode(markdown).width, DEFAULT_FILE_NODE_SIZE.width)
})

test('changing a file node path preserves its canvas identity, geometry and view choice', () => {
  const project = worktreeState().projects[0]
  const original = createFileCanvasNode(
    {
      id: 'file-1',
      path: 'D:\\Development\\Toucan\\README.md',
      position: { x: 41, y: 82 },
      view: 'raw',
      width: 612,
      height: 478
    },
    project,
    callbacks
  )

  const nodes: CanvasNode[] = [original]
  assert.equal(changeFileCanvasNodePath(nodes, 'file-1', original.data.path), nodes)
  assert.equal(changeFileCanvasNodePath(nodes, 'missing', 'D:\\Development\\Toucan\\docs\\next.md'), nodes)

  const changed = changeFileCanvasNodePath(nodes, 'file-1', 'D:\\Development\\Toucan\\docs\\next.md')[0]
  assert.equal(isFileCanvasNode(changed), true)
  assert.equal(changed.id, 'file-1')
  assert.deepEqual(changed.position, { x: 41, y: 82 })
  assert.deepEqual(changed.style, { width: 612, height: 478 })
  assert.equal(changed.data.path, 'D:\\Development\\Toucan\\docs\\next.md')
  assert.equal(changed.data.view, 'raw')
  assert.equal(changed.data.onRequestFilePath, callbacks.onRequestFilePath)
  assert.equal(changed.data.onPathChange, callbacks.onPathChange)
  assert.equal(serializeFileNode(changed as FileCanvasNode).path, 'D:\\Development\\Toucan\\docs\\next.md')
})

/*
 * A diff node (issue #144) reviews a checkout, so it is layout that survives a restart: position,
 * size and the open file come back, a worktree review goes with its worktree, and a primary-checkout
 * review compares against HEAD because that is the only base it has.
 */
test('a diff node survives save, load and restore, and goes with its worktree or project', () => {
  const state = worktreeState()
  state.diffs = [
    {
      id: 'diff-1',
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      position: { x: 0, y: 300 },
      width: 760,
      height: 560,
      selectedPath: 'src/a.ts'
    },
    { id: 'diff-primary', projectId: 'project-1', position: { x: 900, y: 0 }, width: 700, height: 400 },
    {
      id: 'diff-orphan-worktree',
      projectId: 'project-1',
      worktreeId: 'gone',
      position: { x: 0, y: 0 },
      width: 1,
      height: 1
    },
    { id: 'diff-orphan-project', projectId: 'deleted', position: { x: 0, y: 0 }, width: 1, height: 1 }
  ]
  const restored = restoreCanvasWorkspace(state, callbacks)
  const diffs = restored.nodes.filter(isDiffCanvasNode)

  assert.deepEqual(
    diffs.map((node) => node.id),
    ['diff-1', 'diff-primary']
  )
  const [review, primary] = diffs
  assert.equal(review.type, 'diffNode')
  assert.equal(review.dragHandle, '.node-header')
  assert.equal(review.data.path, 'D:\\Development\\Toucan-worktrees\\feature-login')
  assert.equal(review.data.baseRef, 'main')
  assert.equal(review.data.label, 'feature/login')
  assert.equal(review.data.selectedPath, 'src/a.ts')
  assert.equal(review.data.onSelectDiffPath, callbacks.onSelectDiffPath)
  assert.deepEqual(serializeDiffNode(review), state.diffs[0])

  assert.equal(primary.data.path, 'D:\\Development\\Toucan')
  assert.equal(primary.data.baseRef, 'HEAD')
  assert.equal(primary.data.label, 'Toucan')
  assert.equal(primary.data.worktreeId, undefined)
  assert.deepEqual(serializeDiffNode(primary), state.diffs[1])

  // Like a file node, a review is layout: closing one is neither a reopen target nor a wipe.
  assert.equal(isLayoutCanvasNode(review), true)
  assert.deepEqual(rememberClosedSessionNodes([state.nodes[0]], [review]), [state.nodes[0]])
})

test('a fresh diff node takes the default size and remembers the file the reader opens', () => {
  const project = worktreeState().projects[0]
  const node = createDiffCanvasNode({ id: 'diff-new', position: { x: 10, y: 20 } }, project, undefined, callbacks)
  assert.deepEqual(node.style, DEFAULT_DIFF_NODE_SIZE)
  assert.equal(node.data.selectedPath, undefined)

  const nodes: CanvasNode[] = [node]
  const selected = selectDiffCanvasNodePath(nodes, 'diff-new', 'src/a.ts')
  assert.equal((selected[0] as DiffCanvasNode).data.selectedPath, 'src/a.ts')
  assert.equal(serializeDiffNode(selected[0] as DiffCanvasNode).selectedPath, 'src/a.ts')
  assert.equal(selectDiffCanvasNodePath(selected, 'diff-new', 'src/a.ts'), selected, 'same path is a no-op')
  assert.equal(
    (selectDiffCanvasNodePath(selected, 'diff-new', undefined)[0] as DiffCanvasNode).data.selectedPath,
    undefined
  )
  assert.equal(selectDiffCanvasNodePath(nodes, 'missing', 'x'), nodes)
})

test('removing a worktree removes its diff nodes and nothing else', () => {
  const state = worktreeState()
  state.diffs = [
    { id: 'diff-1', projectId: 'project-1', worktreeId: 'worktree-1', position: { x: 0, y: 0 }, width: 1, height: 1 },
    { id: 'diff-primary', projectId: 'project-1', position: { x: 0, y: 0 }, width: 1, height: 1 }
  ]
  const nodes = restoreCanvasWorkspace(state, callbacks).nodes
  const remaining = withoutWorktree(nodes, 'worktree-1')
  assert.deepEqual(remaining.map((node) => node.id).sort(), ['diff-primary', 'node-1', 'node-2'])
  // A diff node is not attached to the worktree: it runs nothing there, so it never blocks removal.
  const worktree = worktreeNodes(nodes)[0]
  assert.equal(worktree.data.attachedNodeCount, 2)
})

/**
 * The bug this replaced: the drop position was the centre of the viewport, but React Flow reads a
 * node's position as its top-left corner, so a new node hung down and to the right of the centre
 * and half of it was off screen. Centring has to account for the node's own size.
 */
test('a centred drop puts the middle of the node in the middle of the region', () => {
  const region = { position: { x: 0, y: 0 }, width: 1000, height: 800 }
  const size = { width: 400, height: 200 }

  const position = centredNodePosition(region, size)

  assert.deepEqual(position, { x: 300, y: 300 })
  // Stated as the property that actually matters, so the arithmetic above cannot drift from intent.
  assert.equal(position.x + size.width / 2, region.position.x + region.width / 2)
  assert.equal(position.y + size.height / 2, region.position.y + region.height / 2)
})

test('a centred drop is relative to the region, not the canvas origin', () => {
  // The visible region is in flow coordinates and moves with pan and zoom; a node centred in it
  // must follow, or a panned canvas drops nodes back at the old spot.
  const region = { position: { x: -500, y: 250 }, width: 600, height: 600 }

  assert.deepEqual(centredNodePosition(region, { width: 200, height: 100 }), { x: -300, y: 500 })
})

test('a node too large for the region keeps its top-left corner inside it', () => {
  // Zoomed in far enough, the region is smaller in flow units than a diff node. Centring such a
  // node would push its header above the visible top, where the title and close button cannot be
  // reached; overhanging only to the right and bottom keeps them.
  const region = { position: { x: 40, y: 60 }, width: 300, height: 200 }

  const position = centredNodePosition(region, DEFAULT_DIFF_NODE_SIZE)

  assert.deepEqual(position, region.position)
})

test('a create action is centred by the size its node is actually built with', () => {
  // An action with no row in `CREATE_NODE_ACTIONS` is already a compile error
  // (`UnlistedCreateAction`). What that cannot catch is a row holding a size of its own instead of
  // the one the construction site reads - then the node is centred by a number nothing else uses,
  // which is the off-centre bug again for that one action.
  assert.equal(NEW_NODE_SIZE['create-terminal'], NEW_SESSION_NODE_SIZE)
  assert.equal(NEW_NODE_SIZE['create-claude'], NEW_SESSION_NODE_SIZE)
  assert.equal(NEW_NODE_SIZE['create-codex'], NEW_SESSION_NODE_SIZE)
  assert.equal(NEW_NODE_SIZE['open-history'], NEW_SESSION_NODE_SIZE)
  assert.equal(NEW_NODE_SIZE['create-worktree'], DEFAULT_WORKTREE_SIZE)
  assert.equal(NEW_NODE_SIZE['open-file'], DEFAULT_FILE_NODE_SIZE)
  assert.equal(NEW_NODE_SIZE['open-diff'], DEFAULT_DIFF_NODE_SIZE)
})

test('a chat node is a session node whose surface is a transcript, never an xterm terminal', () => {
  const project = { id: 'project-1', name: 'Toucan', path: 'D:\\Development\\Toucan', color: '#71a9ff' }
  const state: WorkspaceState = {
    version: 3,
    projects: [project],
    activeProjectId: 'project-1',
    sidebarCollapsed: false,
    nodes: [
      {
        id: 'chat-1',
        kind: 'claude',
        label: 'Claude 1',
        projectId: 'project-1',
        position: { x: 0, y: 0 },
        width: 540,
        height: 360
      },
      {
        id: 'chat-2',
        kind: 'codex',
        label: 'Codex 1',
        projectId: 'project-1',
        position: { x: 0, y: 0 },
        width: 540,
        height: 360
      },
      {
        id: 'term-1',
        kind: 'terminal',
        label: 'Terminal 1',
        projectId: 'project-1',
        position: { x: 0, y: 0 },
        width: 520,
        height: 340
      }
    ],
    worktrees: []
  }
  const nodes = restoreCanvasWorkspace(state, callbacks).nodes
  const chatIds = nodes.filter(isChatCanvasNode).map((node) => node.id)
  assert.deepEqual(chatIds.sort(), ['chat-1', 'chat-2'])

  const file = createFileCanvasNode(
    { id: 'file-1', position: { x: 0, y: 0 }, path: 'D:\\notes.md' },
    project,
    callbacks
  )
  assert.equal(isChatCanvasNode(file), false)
})

/**
 * Issue #165: the worktree node used to be constructed at four sites, each repeating the drag
 * handle, the four project fields, the callbacks and - the load-bearing one - `deletable: false`,
 * which is what stops the Delete key from dropping the record and orphaning a directory git still
 * knows about. One factory means a new construction site cannot forget any of it.
 */
test('every worktree node is built by one factory, with teardown off the Delete key', () => {
  const project = worktreeState().projects[0]
  const created = createWorktreeCanvasNode(
    {
      worktreeId: 'worktree-9',
      branch: 'feature/login',
      path: 'D:\\Development\\Toucan-worktrees\\feature-login',
      baseRef: 'main',
      createdAt: '2026-09-09T09:00:00.000Z',
      position: { x: 24, y: 48 },
      selected: true
    },
    project,
    callbacks
  )

  assert.equal(created.id, 'worktree:worktree-9')
  assert.equal(created.type, 'worktreeNode')
  assert.equal(created.dragHandle, '.node-header')
  assert.equal(created.deletable, false)
  assert.equal(created.selected, true)
  assert.deepEqual(created.style, DEFAULT_WORKTREE_SIZE)
  assert.equal(created.data.attachedNodeCount, 0)
  assert.equal(created.data.setupCommand, 'npm install')
  assert.equal(created.data.projectPath, project.path)
  assert.equal(created.data.projectColor, project.color)
  assert.equal(created.data.onOpenDiff, callbacks.onOpenDiff)

  // A swept or handed-off worktree appears without stealing the selection.
  const quiet = createWorktreeCanvasNode(
    { ...created.data, position: { x: 0, y: 0 }, width: 400, height: 300 },
    project,
    callbacks
  )
  assert.equal(quiet.selected, undefined)
  assert.deepEqual(quiet.style, { width: 400, height: 300 })

  // The restore path is the same factory, so a restored node is indistinguishable from a fresh one.
  const restored = worktreeNodes(restoreCanvasWorkspace(worktreeState(), callbacks).nodes)[0]
  assert.equal(restored.deletable, false)
  assert.equal(restored.dragHandle, '.node-header')
})

test('the worktree node is constructed nowhere but its factory', () => {
  const sources = (directory: string): string[] =>
    readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) return sources(path)
      return /\.tsx?$/.test(entry.name) ? [path] : []
    })

  const constructing = sources(join(process.cwd(), 'src'))
    .filter((path) => /type: 'worktreeNode'/.test(readFileSync(path, 'utf8')))
    .map((path) => path.slice(join(process.cwd(), 'src').length + 1).replace(/\\/g, '/'))

  assert.deepEqual(constructing, ['renderer/src/canvas-workspace.ts'])
})

/**
 * One pass over the canvas produces one array per kind, including the rule that a kind added after
 * version 3 was set stays absent rather than being written as an empty array - a workspace that
 * never opened a file or a diff keeps writing exactly the snapshot shape it always did.
 */
test('serializing the canvas writes one array per kind and omits the kinds with nothing in them', () => {
  const state = worktreeState()
  state.files = [
    {
      id: 'file-1',
      projectId: 'project-1',
      path: 'D:\\Development\\Toucan\\docs\\plan.md',
      view: 'raw',
      position: { x: 900, y: 40 },
      width: 480,
      height: 560
    }
  ]
  const nodes = restoreCanvasWorkspace(state, callbacks).nodes

  const serialized = serializeCanvasNodes(nodes)
  assert.deepEqual(serialized.nodes, nodes.filter(isTerminalCanvasNode).map(serializeCanvasNode))
  assert.deepEqual(serialized.worktrees, state.worktrees)
  assert.deepEqual(serialized.files, state.files)
  assert.equal('diffs' in serialized, false)
  // The two fields version 3 has always had are written even when the canvas has none of them.
  const empty = serializeCanvasNodes([])
  assert.deepEqual(empty, { nodes: [], worktrees: [] })

  // `beforeSave` is how a node maximised into fit mode is persisted at the geometry it returns to.
  const shrunk = serializeCanvasNodes(nodes, (node) => ({ ...node, style: { width: 10, height: 20 } }))
  assert.equal(shrunk.nodes[0].width, 10)
  assert.equal(shrunk.worktrees[0].height, 20)
})

/**
 * The acceptance issue #165 was written for: a kind's mechanical concerns are one table entry, so
 * a fifth kind costs that entry and one `WorkspaceState` field instead of an edit to every loop
 * that walks the canvas. The casts stand in for the two things a real kind also brings and a test
 * cannot: a member of the `CanvasNode` union and a declared field on `WorkspaceState`.
 */
test('a fifth node kind is one table entry and one workspace field', () => {
  interface SavedNote {
    id: string
    projectId: string
    text: string
    position: { x: number; y: number }
    width: number
    height: number
  }

  const noteKind = canvasNodeKind<SavedNote, CanvasNode>({
    field: 'notes' as CanvasNodeStateField,
    alwaysPersisted: false,
    is: (node): node is CanvasNode => node.type === ('noteNode' as CanvasNode['type']),
    serialize: (node) => ({
      id: node.id,
      projectId: node.data.projectId,
      text: String(node.data.text),
      position: node.position,
      width: 200,
      height: 120
    }),
    restore: (saved, project) =>
      ({
        id: saved.id,
        type: 'noteNode',
        dragHandle: '.node-header',
        position: saved.position,
        data: {
          text: saved.text,
          projectId: project.id,
          projectName: project.name,
          projectPath: project.path,
          projectColor: project.color
        }
      }) as unknown as CanvasNode
  })

  const kinds = [...CANVAS_NODE_KINDS, noteKind]
  const notes: SavedNote[] = [
    { id: 'note-1', projectId: 'project-1', text: 'ship it', position: { x: 12, y: 34 }, width: 200, height: 120 },
    { id: 'note-orphan', projectId: 'deleted', text: 'gone', position: { x: 0, y: 0 }, width: 200, height: 120 }
  ]
  const state = { ...worktreeState(), notes } as unknown as WorkspaceState

  const restored = restoreCanvasWorkspace(state, callbacks, kinds)
  const restoredNotes = restored.nodes.filter((node) => noteKind.is(node))

  // Pruning a record whose project is gone is the loop's one rule, so the entry never wrote it.
  assert.deepEqual(
    restoredNotes.map((node) => node.id),
    ['note-1']
  )
  assert.equal(restoredNotes[0].data.projectColor, '#71a9ff')
  // The kinds that were already there are untouched by the new entry.
  assert.deepEqual(
    terminalNodes(restored.nodes).map((node) => node.id),
    ['node-1', 'node-2']
  )

  const serialized = serializeCanvasNodes(restored.nodes, undefined, kinds)
  assert.deepEqual((serialized as unknown as { notes: SavedNote[] }).notes, [notes[0]])
  assert.deepEqual(serialized.worktrees, state.worktrees)
})

/**
 * A project's colour is denormalised onto every node it owns, so a change has to reach all of
 * them in the same update or the sidebar retints while the canvas keeps the old tint.
 */
test('recolouring a project reaches every kind of node it owns and nothing else', () => {
  const state = worktreeState()
  state.projects.push({ id: 'project-2', name: 'Other', path: 'D:\\Other', color: '#f0a5c3' })
  state.files = [
    {
      id: 'file-1',
      projectId: 'project-1',
      path: 'D:\\Development\\Toucan\\README.md',
      view: 'rendered',
      position: { x: 0, y: 0 },
      width: 480,
      height: 560
    }
  ]
  state.diffs = [{ id: 'diff-1', projectId: 'project-2', position: { x: 0, y: 0 }, width: 760, height: 560 }]
  const nodes = restoreCanvasWorkspace(state, callbacks).nodes

  const recoloured = withProjectColor(nodes, 'project-1', '#b6e3a5')

  for (const node of recoloured) {
    assert.equal(node.data.projectColor, node.data.projectId === 'project-1' ? '#b6e3a5' : '#f0a5c3')
  }
  assert.equal(
    recoloured.every((node) => node.type === nodes.find((original) => original.id === node.id)?.type),
    true
  )
  // The same colour is not a change, so the canvas is not re-rendered for it.
  assert.equal(withProjectColor(recoloured, 'project-1', '#b6e3a5'), recoloured)
  assert.equal(withProjectColor(nodes, 'missing-project', '#b6e3a5'), nodes)
})

/**
 * A node that has not reported a status yet is read from the node itself, in one place: the
 * sidebar row, the restored workspace, a just-reopened node and the worktree adoption gate all
 * used to default it separately, and a gate reading `starting` where a row read `dormant` is a
 * node that can never be adopted.
 */
test('a session node with no reported status is read from the node, not defaulted per caller', () => {
  const state = worktreeState()
  const restored = restoreCanvasWorkspace(state, callbacks)
  const chat = terminalNodes(restored.nodes).find((node) => node.data.kind === 'claude')!
  const terminal = terminalNodes(restored.nodes).find((node) => node.data.kind === 'terminal')!

  assert.equal(sessionNodeStatus(chat), 'starting')
  assert.equal(sessionNodeStatus(terminal), 'dormant')
  assert.equal(sessionNodeStatus(chat, restored.statuses), 'starting')
  assert.equal(sessionNodeStatus(chat, { [chat.id]: 'working' }), 'working')
  // What the restored workspace reports is the same function, so the two cannot drift.
  assert.deepEqual(restored.statuses, { 'node-1': 'starting', 'node-2': 'dormant' })
})

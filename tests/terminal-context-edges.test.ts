import { strict as assert } from 'node:assert'
import { test } from 'vitest'
import type { Edge } from '@xyflow/react'
import { restoreCanvasWorkspace, type CanvasNode } from '../src/renderer/src/canvas-workspace'
import {
  adoptTerminalContext,
  isValidTerminalContextConnection,
  mirroredTerminalContextEdges,
  planTerminalContextAdoptions,
  terminalContextEdgeId,
  withTerminalContextEdge,
  withoutEdgesTouchingNodes
} from '../src/renderer/src/terminal-context-edges'
import type { WorkspaceState } from '../src/shared/workspace'

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

/** A canvas with one terminal (durable session `shell-1`), one chat, and one file node. */
function canvasNodes(): CanvasNode[] {
  const state: WorkspaceState = {
    version: 3,
    projects: [{ id: 'project-1', name: 'Toucan', path: 'D:\\Development\\Toucan', color: '#71a9ff' }],
    activeProjectId: 'project-1',
    sidebarCollapsed: false,
    nodes: [
      {
        id: 'terminal-node',
        sessionId: 'shell-1',
        kind: 'terminal',
        label: 'Terminal 1',
        projectId: 'project-1',
        position: { x: 0, y: 0 },
        width: 520,
        height: 340
      },
      {
        id: 'chat-node',
        kind: 'claude',
        label: 'Claude 2',
        projectId: 'project-1',
        position: { x: 600, y: 0 },
        width: 750,
        height: 660,
        conversationId: 'conversation-2'
      },
      {
        id: 'second-chat',
        kind: 'codex',
        label: 'Codex 3',
        projectId: 'project-1',
        position: { x: 600, y: 700 },
        width: 750,
        height: 660,
        conversationId: 'conversation-3'
      }
    ],
    worktrees: [],
    files: [
      {
        id: 'file-node',
        projectId: 'project-1',
        path: 'D:\\Development\\Toucan\\README.md',
        view: 'rendered',
        position: { x: 0, y: 400 },
        width: 480,
        height: 560
      }
    ]
  }
  return restoreCanvasWorkspace(state, callbacks).nodes
}

test('admits terminal → chat and nothing else', () => {
  const nodes = canvasNodes()
  assert.equal(isValidTerminalContextConnection(nodes, { source: 'terminal-node', target: 'chat-node' }), true)
  // Reversed roles, chat → chat, terminal → terminal, layout nodes, self, unknown ids: all refused.
  assert.equal(isValidTerminalContextConnection(nodes, { source: 'chat-node', target: 'terminal-node' }), false)
  assert.equal(isValidTerminalContextConnection(nodes, { source: 'chat-node', target: 'second-chat' }), false)
  assert.equal(isValidTerminalContextConnection(nodes, { source: 'terminal-node', target: 'terminal-node' }), false)
  assert.equal(isValidTerminalContextConnection(nodes, { source: 'terminal-node', target: 'file-node' }), false)
  assert.equal(isValidTerminalContextConnection(nodes, { source: 'file-node', target: 'chat-node' }), false)
  assert.equal(isValidTerminalContextConnection(nodes, { source: 'terminal-node', target: 'missing' }), false)
  assert.equal(isValidTerminalContextConnection(nodes, { source: null, target: 'chat-node' }), false)
})

test('a dormant terminal still connects: the retained tail is exactly what an agent reads after an exit', () => {
  const nodes = canvasNodes().map((node) =>
    node.id === 'terminal-node' ? { ...node, data: { ...node.data, dormant: true } } : node
  ) as CanvasNode[]
  assert.equal(isValidTerminalContextConnection(nodes, { source: 'terminal-node', target: 'chat-node' }), true)
})

test('withTerminalContextEdge appends once and refuses invalid connections', () => {
  const nodes = canvasNodes()
  const first = withTerminalContextEdge([], nodes, { source: 'terminal-node', target: 'chat-node' })
  assert.equal(first.length, 1)
  assert.equal(first[0].id, terminalContextEdgeId('terminal-node', 'chat-node'))

  const duplicate = withTerminalContextEdge(first, nodes, { source: 'terminal-node', target: 'chat-node' })
  assert.equal(duplicate.length, 1)

  const invalid = withTerminalContextEdge(first, nodes, { source: 'chat-node', target: 'second-chat' })
  assert.deepEqual(
    invalid.map((edge) => edge.id),
    first.map((edge) => edge.id)
  )

  const second = withTerminalContextEdge(first, nodes, { source: 'terminal-node', target: 'second-chat' })
  assert.equal(second.length, 2)
})

test('closing either node drops the edges touching it', () => {
  const edges: Edge[] = [
    { id: 'a', source: 'terminal-node', target: 'chat-node' },
    { id: 'b', source: 'terminal-node', target: 'second-chat' },
    { id: 'c', source: 'other-terminal', target: 'second-chat' }
  ]
  assert.deepEqual(
    withoutEdgesTouchingNodes(edges, new Set(['chat-node'])).map((edge) => edge.id),
    ['b', 'c']
  )
  assert.deepEqual(
    withoutEdgesTouchingNodes(edges, new Set(['terminal-node'])).map((edge) => edge.id),
    ['c']
  )
  assert.deepEqual(
    withoutEdgesTouchingNodes(edges, new Set(['second-chat', 'terminal-node'])).map((edge) => edge.id),
    []
  )
})

test('mirrors edges as durable terminal sessionId plus agent session id', () => {
  const nodes = canvasNodes()
  const edges = withTerminalContextEdge([], nodes, { source: 'terminal-node', target: 'chat-node' })
  assert.deepEqual(mirroredTerminalContextEdges(nodes, edges), [
    // The terminal's durable sessionId, never its canvas node id; the agent id is the chat node id.
    { terminalSessionId: 'shell-1', agentId: 'chat-node' }
  ])
})

test('an edge whose endpoint vanished or is the wrong kind mirrors as nothing', () => {
  const nodes = canvasNodes()
  const stale: Edge[] = [
    { id: 'gone-source', source: 'missing-terminal', target: 'chat-node' },
    { id: 'gone-target', source: 'terminal-node', target: 'missing-chat' },
    { id: 'wrong-kind', source: 'file-node', target: 'chat-node' }
  ]
  assert.deepEqual(mirroredTerminalContextEdges(nodes, stale), [])
})

// Mid-session adoption (the worktree-claim pattern): an edge drawn onto a running session
// restarts it at a safe boundary so the recreated session carries the read tool.

const edgeToChat: Edge[] = [{ id: 'edge', source: 'terminal-node', target: 'chat-node' }]

test('plans a restart only for a connected live session that launched without the tool', () => {
  const nodes = canvasNodes()

  assert.deepEqual(planTerminalContextAdoptions(nodes, edgeToChat, { 'chat-node': 'idle' }, { 'chat-node': false }), [
    'chat-node'
  ])
  assert.deepEqual(planTerminalContextAdoptions(nodes, edgeToChat, { 'chat-node': 'result' }, { 'chat-node': false }), [
    'chat-node'
  ])
  // A session that already carries the tool - or one whose launch report is still on its way
  // (unknown) - is never restarted for an edge it can already serve or will pick up itself.
  assert.deepEqual(planTerminalContextAdoptions(nodes, edgeToChat, { 'chat-node': 'idle' }, { 'chat-node': true }), [])
  assert.deepEqual(planTerminalContextAdoptions(nodes, edgeToChat, { 'chat-node': 'idle' }, {}), [])
  // No edge, no restart: removal forces nothing - the registry already refuses at call time.
  assert.deepEqual(planTerminalContextAdoptions(nodes, [], { 'chat-node': 'idle' }, { 'chat-node': false }), [])
})

test('never restarts across a boundary with something in flight, or a session that is not live', () => {
  const nodes = canvasNodes()
  for (const status of ['working', 'starting', 'attention', 'stalled', 'exited', 'dormant'] as const) {
    assert.deepEqual(
      planTerminalContextAdoptions(nodes, edgeToChat, { 'chat-node': status }, { 'chat-node': false }),
      [],
      `status ${status} must not restart`
    )
  }
  const dormant = nodes.map((node) =>
    node.id === 'chat-node' ? { ...node, data: { ...node.data, dormant: true } } : node
  ) as CanvasNode[]
  assert.deepEqual(
    planTerminalContextAdoptions(dormant, edgeToChat, { 'chat-node': 'idle' }, { 'chat-node': false }),
    []
  )
})

test('a session with no conversation to resume is never restarted - the restart must replay, not replace', () => {
  const nodes = canvasNodes().map((node) =>
    node.id === 'chat-node' ? { ...node, data: { ...node.data, conversationId: undefined } } : node
  ) as CanvasNode[]
  assert.deepEqual(planTerminalContextAdoptions(nodes, edgeToChat, { 'chat-node': 'idle' }, { 'chat-node': false }), [])
})

test('adopting bumps the restart nonce and resumes the same conversation', () => {
  const nodes = canvasNodes()
  const adopted = adoptTerminalContext(nodes, ['chat-node'])
  const chat = adopted.find((node) => node.id === 'chat-node')!
  assert.equal(chat.data.terminalContextNonce, 1)
  assert.equal(chat.data.launchMode, 'resume')
  // A second adoption later in the session's life restarts again rather than being spent forever.
  const again = adoptTerminalContext(adopted, ['chat-node']).find((node) => node.id === 'chat-node')!
  assert.equal(again.data.terminalContextNonce, 2)
  // Untouched nodes and an empty plan keep their references: no re-render for a no-op.
  assert.equal(
    adopted.find((node) => node.id === 'second-chat'),
    nodes.find((node) => node.id === 'second-chat')
  )
  assert.equal(adoptTerminalContext(nodes, []), nodes)
})

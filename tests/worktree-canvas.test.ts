import { strict as assert } from 'node:assert'
import type { Edge } from '@xyflow/react'
import { test } from 'vitest'
import {
  createSessionCanvasNode,
  createWorktreeCanvasNode,
  DEFAULT_WORKTREE_SIZE,
  NEW_SESSION_NODE_SIZE,
  WORKTREE_CHILD_GAP,
  type CanvasNode,
  type TerminalCanvasNode,
  type WorktreeCanvasNode
} from '../src/renderer/src/canvas-workspace'
import {
  nextWorktreeChildPosition,
  partitionWorktreeCanvases,
  splitWorktreeCanvasEdges,
  withRoomForChat,
  worktreeActivity
} from '../src/renderer/src/worktree-canvas'
import type { WorkspaceProject } from '../src/shared/workspace'

const PROJECT: WorkspaceProject = { id: 'project-1', name: 'Toucan', path: 'D:\\Development\\toucan', color: '#8ab4f8' }

const noop = (): undefined => undefined
const sessionCallbacks = {
  onStatusChange: noop,
  onConversationId: noop,
  onTitleChange: async () => true,
  onFocusModeChange: noop,
  onDraftChange: noop,
  onPermissionModeChange: noop,
  onModelChange: noop,
  onResume: noop
}
const worktreeCallbacks = {
  onRemoveWorktree: noop,
  onCreateNodeInWorktree: noop,
  onRunSetupCommand: noop,
  onOpenDiff: noop,
  onViewportChange: noop
}

function worktree(id: string, size?: { width: number; height: number }): WorktreeCanvasNode {
  return createWorktreeCanvasNode(
    {
      worktreeId: id,
      branch: `feature/${id}`,
      path: `D:\\Development\\toucan-worktrees\\${id}`,
      baseRef: 'main',
      createdAt: '2026-09-28T00:00:00.000Z',
      position: { x: 0, y: 0 },
      ...size
    },
    PROJECT,
    worktreeCallbacks
  )
}

function session(
  id: string,
  kind: 'claude' | 'codex' | 'terminal',
  worktreeId?: string,
  position = { x: 0, y: 0 }
): TerminalCanvasNode {
  const home = worktreeId
    ? { worktreeId, branch: `feature/${worktreeId}`, path: `D:\\Development\\toucan-worktrees\\${worktreeId}` }
    : undefined
  return {
    ...createSessionCanvasNode({ id, kind, label: id, position, launchMode: 'new' }, PROJECT, home, sessionCallbacks),
    selected: false
  }
}

test('every attached chat is shown exactly once, in its own worktree, and nothing else leaves the main canvas', () => {
  const nodes: CanvasNode[] = [
    worktree('a'),
    worktree('b'),
    session('codex-a', 'codex', 'a'),
    session('claude-a', 'claude', 'a'),
    session('claude-b', 'claude', 'b'),
    session('loose', 'claude'),
    // A terminal stays where it is for now, attached or not.
    session('terminal-a', 'terminal', 'a')
  ]

  const partition = partitionWorktreeCanvases(nodes)

  assert.deepEqual(
    partition.main.map((node) => node.id),
    ['worktree:a', 'worktree:b', 'loose', 'terminal-a']
  )
  assert.deepEqual(
    partition.children.get('a')?.map((node) => node.id),
    ['codex-a', 'claude-a']
  )
  assert.deepEqual(
    partition.children.get('b')?.map((node) => node.id),
    ['claude-b']
  )
  const shown = [...partition.main, ...[...partition.children.values()].flat()].map((node) => node.id)
  assert.deepEqual([...shown].sort(), nodes.map((node) => node.id).sort())
})

test('an empty worktree still has a canvas, and a chat whose worktree node is missing stays visible', () => {
  const orphan = session('orphan', 'codex', 'gone')
  const partition = partitionWorktreeCanvases([worktree('a'), orphan])

  assert.deepEqual(partition.children.get('a'), [])
  assert.equal(partition.children.has('gone'), false)
  assert.deepEqual(
    partition.main.map((node) => node.id),
    ['worktree:a', 'orphan']
  )
})

test('a canvas whose members did not change keeps the very same array, so its React Flow is not re-fed', () => {
  const chat = session('chat', 'claude', 'a')
  const loose = session('loose', 'claude')
  const first = partitionWorktreeCanvases([worktree('a'), worktree('b'), chat, loose])
  const movedLoose = { ...loose, position: { x: 400, y: 0 } }
  const second = partitionWorktreeCanvases([...first.main.filter((node) => node !== loose), movedLoose, chat], first)

  assert.equal(second.children.get('a'), first.children.get('a'))
  assert.equal(second.children.get('b'), first.children.get('b'))
  assert.notEqual(second.main, first.main)

  const movedChat = { ...chat, position: { x: 10, y: 10 } }
  const third = partitionWorktreeCanvases([...second.main, movedChat], second)
  assert.equal(third.main, second.main)
  assert.notEqual(third.children.get('a'), second.children.get('a'))
})

test('edges are drawn on the canvas holding both of their ends and nowhere else', () => {
  const partition = partitionWorktreeCanvases([
    worktree('a'),
    session('parent', 'claude', 'a'),
    session('child', 'claude', 'a'),
    session('loose', 'claude'),
    session('terminal', 'terminal')
  ])
  const edges: Edge[] = [
    { id: 'lineage', source: 'parent', target: 'child' },
    { id: 'context', source: 'terminal', target: 'loose' },
    { id: 'across', source: 'terminal', target: 'child' }
  ]

  const split = splitWorktreeCanvasEdges(edges, partition)

  assert.deepEqual(
    split.main.map((edge) => edge.id),
    ['context']
  )
  assert.deepEqual(
    split.children.get('a')?.map((edge) => edge.id),
    ['lineage']
  )
})

test('a new chat goes beside the rightmost one, top-aligned, and the first at the canvas origin', () => {
  assert.deepEqual(nextWorktreeChildPosition([]), { x: 0, y: 0 })

  const left = session('left', 'claude', 'a', { x: 0, y: 40 })
  const right = { ...session('right', 'codex', 'a', { x: 900, y: 10 }), measured: { width: 500, height: 400 } }
  assert.deepEqual(nextWorktreeChildPosition([left, right]), { x: 900 + 500 + WORKTREE_CHILD_GAP, y: 10 })
  assert.deepEqual(nextWorktreeChildPosition([left]), {
    x: NEW_SESSION_NODE_SIZE.width + WORKTREE_CHILD_GAP,
    y: 40
  })
})

test('a worktree too small for a chat grows to the size a new one opens at, and a roomy one is left alone', () => {
  const small = worktree('a', { width: 360, height: 232 })
  const grown = withRoomForChat([small], 'a')[0] as WorktreeCanvasNode
  assert.deepEqual(grown.style, { width: DEFAULT_WORKTREE_SIZE.width, height: DEFAULT_WORKTREE_SIZE.height })
  assert.equal(grown.data, small.data)

  const roomy = worktree('b', { width: 1200, height: 900 })
  const nodes = [roomy]
  assert.equal(withRoomForChat(nodes, 'b'), nodes)
})

test('the activity line counts chats and what they are doing, not the git state of the checkout', () => {
  const chats = [session('one', 'claude', 'a'), session('two', 'codex', 'a'), session('three', 'codex', 'a')]
  assert.deepEqual(worktreeActivity(chats, { one: 'working', two: 'attention' }), {
    chats: 3,
    working: 1,
    attention: 1
  })
  assert.deepEqual(worktreeActivity([], {}), { chats: 0, working: 0, attention: 0 })
})

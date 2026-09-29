import { strict as assert } from 'node:assert'
import type { Edge } from '@xyflow/react'
import { test } from 'vitest'
import {
  COLLAPSED_WORKTREE_HEIGHT,
  createSessionCanvasNode,
  createWorktreeCanvasNode,
  DEFAULT_WORKTREE_SIZE,
  NEW_SESSION_NODE_SIZE,
  serializeWorktreeNode,
  WORKTREE_CHILD_GAP,
  type CanvasNode,
  type TerminalCanvasNode,
  type WorktreeCanvasNode
} from '../src/renderer/src/canvas-workspace'
import {
  collapseWorktree,
  expandWorktree,
  isCollapsedWorktree,
  keepCollapsed,
  layoutGeometry,
  nextWorktreeChildPosition,
  partitionWorktreeCanvases,
  selectOnlyWithinCanvas,
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
  onViewportChange: noop,
  onToggleCollapsed: noop
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

test('the activity line counts what the chats are doing, not the git state of the checkout', () => {
  const chats = [session('one', 'claude', 'a'), session('two', 'codex', 'a'), session('three', 'codex', 'a')]
  assert.deepEqual(worktreeActivity(chats, { one: 'working', two: 'attention' }), {
    working: 1,
    attention: 1
  })
  assert.deepEqual(worktreeActivity([], {}), { working: 0, attention: 0 })
})

test('moving a worktree moves nothing inside it: its chats keep their geometry, cwd and canvas array', () => {
  const host = worktree('a')
  const chats = [session('one', 'claude', 'a', { x: 0, y: 0 }), session('two', 'codex', 'a', { x: 798, y: 0 })]
  const before = partitionWorktreeCanvases([host, ...chats])

  const moved = { ...host, position: { x: 2400, y: -600 } }
  const after = partitionWorktreeCanvases([moved, ...chats], before)

  assert.equal(after.children.get('a'), before.children.get('a'))
  assert.deepEqual(
    after.children.get('a')?.map((node) => [node.position, node.data.workingDirectory]),
    chats.map((node) => [node.position, node.data.workingDirectory])
  )
})

test('a chat dropped over a worktree frame is not adopted by it: only attachment moves a chat, never geometry', () => {
  const host = worktree('a', { width: 1200, height: 800 })
  const loose = session('loose', 'claude', undefined, { x: 200, y: 200 })

  const partition = partitionWorktreeCanvases([host, loose])

  assert.deepEqual(
    partition.main.map((node) => node.id),
    ['worktree:a', 'loose']
  )
  assert.deepEqual(partition.children.get('a'), [])
  assert.equal(partition.main[1].data.workingDirectory, PROJECT.path)
})

test('selecting on one canvas clears the selection on every other, so one Delete can close only what is in view', () => {
  const selected = <T extends CanvasNode>(node: T): T => ({ ...node, selected: true })
  const nodes: CanvasNode[] = [
    selected(worktree('a')),
    worktree('b'),
    selected(session('in-a', 'claude', 'a')),
    selected(session('in-b', 'codex', 'b')),
    selected(session('loose', 'claude'))
  ]
  const ids = (next: CanvasNode[]): string[] => next.filter((node) => node.selected).map((node) => node.id)

  assert.deepEqual(ids(selectOnlyWithinCanvas(nodes, 'a')), ['in-a'])
  assert.deepEqual(ids(selectOnlyWithinCanvas(nodes, 'b')), ['in-b'])
  // A worktree's frame belongs to the main canvas, so picking it clears the chats inside it too.
  assert.deepEqual(ids(selectOnlyWithinCanvas(nodes, null)), ['worktree:a', 'loose'])
  const quiet = nodes.map((node) => ({ ...node, selected: false }))
  assert.equal(selectOnlyWithinCanvas(quiet, 'a'), quiet)
})

test('collapsing a worktree is a change of height only, and expanding returns the height it had', () => {
  const host = { ...worktree('a', { width: 900, height: 700 }), measured: { width: 900, height: 700 } }
  const chats = [session('in-a', 'claude', 'a'), session('loose', 'codex')]
  const nodes: CanvasNode[] = [host, ...chats]

  const collapsed = collapseWorktree(nodes, 'a')
  const shelved = collapsed[0] as WorktreeCanvasNode
  assert.equal(isCollapsedWorktree(shelved), true)
  assert.equal(shelved.style?.height, COLLAPSED_WORKTREE_HEIGHT)
  assert.equal(shelved.style?.width, 900)
  assert.equal(shelved.data.expandedHeight, 700)
  // Every other node is the same object: nothing about the chats changed, so nothing remounts.
  assert.deepEqual(collapsed.slice(1), chats)
  assert.equal(collapsed[1], chats[0])
  // Its chats still partition onto its canvas - it is shown, just out of view.
  assert.deepEqual(
    partitionWorktreeCanvases(collapsed)
      .children.get('a')
      ?.map((node) => node.id),
    ['in-a']
  )
  // Saved at the height it expands back to, and as collapsed.
  assert.deepEqual(
    { ...serializeWorktreeNode(shelved), createdAt: '' },
    { ...serializeWorktreeNode(host), createdAt: '', collapsed: true }
  )
  assert.equal(serializeWorktreeNode(shelved).height, 700)

  const expanded = expandWorktree(collapsed, 'a')
  const back = expanded[0] as WorktreeCanvasNode
  assert.equal(isCollapsedWorktree(back), false)
  assert.equal(back.style?.height, 700)
  assert.equal(back.data.expandedHeight, undefined)
  assert.equal(expanded[1], chats[0])

  // Idempotent, and quiet about worktrees that are not there.
  assert.equal(collapseWorktree(collapsed, 'a'), collapsed)
  assert.equal(expandWorktree(nodes, 'a'), nodes)
  assert.equal(collapseWorktree(nodes, 'missing'), nodes)
})

test('a worktree restored collapsed opens at its chrome height and remembers the saved height', () => {
  const restored = createWorktreeCanvasNode(
    {
      worktreeId: 'a',
      branch: 'feature/a',
      path: 'D:\\Development\\toucan-worktrees\\a',
      baseRef: 'main',
      createdAt: '2026-09-28T00:00:00.000Z',
      position: { x: 0, y: 0 },
      width: 900,
      height: 700,
      collapsed: true
    },
    PROJECT,
    worktreeCallbacks
  )
  assert.equal(restored.style?.height, COLLAPSED_WORKTREE_HEIGHT)
  assert.equal(restored.data.collapsed, true)
  assert.equal(restored.data.expandedHeight, 700)
  assert.deepEqual(
    { height: serializeWorktreeNode(restored).height, collapsed: serializeWorktreeNode(restored).collapsed },
    { height: 700, collapsed: true }
  )
  assert.equal(expandWorktree([restored], 'a')[0].style?.height, 700)
})

test('a layout slot remembers a collapsed worktree at its expanded height and restores it still collapsed', () => {
  const host = { ...worktree('a', { width: 900, height: 700 }), measured: { width: 900, height: 700 } }
  const collapsed = collapseWorktree([host, session('loose', 'codex')], 'a')
  // Captured as the arrangement: the height it expands back to, nothing else touched.
  const captured = layoutGeometry(collapsed)
  assert.equal(captured[0].style?.height, 700)
  assert.equal((captured[0] as WorktreeCanvasNode).data.collapsed, true)
  assert.equal(captured[1], collapsed[1])
  assert.equal(layoutGeometry([host]).length, 1)
  assert.equal(layoutGeometry([host])[0], host)

  // A slot applied to a collapsed worktree hands it a full height; it stays collapsed and
  // takes that height as the one to expand back to.
  const placed = collapsed.map((node) =>
    node === collapsed[0]
      ? { ...node, style: { ...node.style, height: 500 }, measured: { width: 900, height: 500 } }
      : node
  )
  const kept = keepCollapsed(placed)
  const shelved = kept[0] as WorktreeCanvasNode
  assert.equal(shelved.style?.height, COLLAPSED_WORKTREE_HEIGHT)
  assert.equal(shelved.data.expandedHeight, 500)
  assert.equal(expandWorktree(kept, 'a')[0].style?.height, 500)
  assert.equal(keepCollapsed(collapsed)[0], collapsed[0])
  assert.equal(keepCollapsed([host])[0], host)
})

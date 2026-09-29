import { strict as assert } from 'node:assert'
import { test } from 'vitest'
import {
  createSessionCanvasNode,
  createWorktreeCanvasNode,
  type CanvasNode,
  type TerminalCanvasNode,
  type WorktreeCanvasNode
} from '../src/renderer/src/canvas-workspace'
import { collapseWorktree, partitionWorktreeCanvases } from '../src/renderer/src/worktree-canvas'
import { mostUrgentAttention, summarizeWorktrees, worktreeAttentionTotal } from '../src/renderer/src/worktree-overview'
import { applyAttentionAction, type AttentionKind, type AttentionState } from '../src/shared/attention'
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

function worktree(id: string): WorktreeCanvasNode {
  return createWorktreeCanvasNode(
    {
      worktreeId: id,
      branch: `feature/${id}`,
      path: `D:\\Development\\toucan-worktrees\\${id}`,
      baseRef: 'main',
      createdAt: '2026-09-28T00:00:00.000Z',
      position: { x: 0, y: 0 }
    },
    PROJECT,
    worktreeCallbacks
  )
}

function chat(
  id: string,
  worktreeId: string | undefined,
  extra: Partial<TerminalCanvasNode['data']> = {}
): TerminalCanvasNode {
  const home = worktreeId
    ? { worktreeId, branch: `feature/${worktreeId}`, path: `D:\\Development\\toucan-worktrees\\${worktreeId}` }
    : undefined
  const node = createSessionCanvasNode(
    { id, kind: 'codex', label: id, position: { x: 0, y: 0 }, launchMode: 'new' },
    PROJECT,
    home,
    sessionCallbacks
  )
  return { ...node, data: { ...node.data, ...extra } }
}

function raise(state: AttentionState, nodeId: string, kind: AttentionKind, key?: string): AttentionState {
  return applyAttentionAction(state, { type: 'raise', signal: { nodeId, kind, key } }, 1_000)
}

function summaries(nodes: CanvasNode[], statuses = {}, records: AttentionState = []) {
  return summarizeWorktrees(nodes, partitionWorktreeCanvases(nodes), statuses, records)
}

test('every worktree on the canvas is summarized, in canvas order, named by its task and its branch', () => {
  const nodes: CanvasNode[] = [
    worktree('b'),
    worktree('a'),
    chat('titled', 'a', { label: 'Fix the login redirect', titleSource: 'generated' }),
    chat('untitled', 'b')
  ]
  const overview = summaries(nodes)

  assert.deepEqual(
    overview.map((summary) => [summary.worktreeId, summary.nodeId, summary.branch, summary.task]),
    [
      ['b', 'worktree:b', 'feature/b', undefined],
      ['a', 'worktree:a', 'feature/a', 'Fix the login redirect']
    ]
  )
  assert.equal(overview[0].projectName, 'Toucan')
})

test('agent activity comes from the session state of its own chats only', () => {
  const nodes: CanvasNode[] = [
    worktree('a'),
    worktree('b'),
    chat('one', 'a'),
    chat('two', 'a'),
    chat('three', 'b'),
    chat('loose', undefined)
  ]
  const [a, b] = summaries(nodes, { one: 'working', two: 'stalled', three: 'idle', loose: 'working' })

  assert.equal(a.chats, 2)
  assert.equal(a.working, 2)
  assert.equal(b.chats, 1)
  assert.equal(b.working, 0)
})

test('attention lists each chat with unread records, keeps chat order, and counts every record', () => {
  const nodes: CanvasNode[] = [worktree('a'), chat('first', 'a'), chat('quiet', 'a'), chat('second', 'a')]
  let records: AttentionState = []
  records = raise(records, 'second', 'approval', 'perm-1')
  records = raise(records, 'first', 'result', 'turn-1')
  records = raise(records, 'first', 'failure', 'boom')
  records = raise(records, 'second', 'auth')

  const [a] = summaries(nodes, {}, records)

  assert.deepEqual(
    a.attention.map((item) => [item.nodeId, item.kind, item.count]),
    [
      ['first', 'failure', 2],
      ['second', 'approval', 2]
    ]
  )
  assert.equal(worktreeAttentionTotal(a), 4)
  assert.match(a.attention[1].description, /1 approval/)
  assert.match(a.attention[1].description, /1 sign-in request/)
  // The header's shortcut goes to the approval, not to the chat that happens to be first.
  assert.equal(mostUrgentAttention(a)?.nodeId, 'second')
})

test('read records are history, not attention, and records of chats elsewhere are not counted', () => {
  const nodes: CanvasNode[] = [worktree('a'), chat('one', 'a'), chat('loose', undefined)]
  let records = raise([], 'one', 'result', 'turn-1')
  records = raise(records, 'loose', 'approval', 'perm-1')
  records = applyAttentionAction(records, { type: 'read', nodeId: 'one' }, 2_000)

  const [a] = summaries(nodes, {}, records)
  assert.deepEqual(a.attention, [])
  assert.equal(worktreeAttentionTotal(a), 0)
})

test('a collapsed worktree still reports what its chats need', () => {
  const nodes = collapseWorktree([worktree('a'), chat('one', 'a')], 'a')
  const [a] = summaries(nodes, { one: 'working' }, raise([], 'one', 'approval', 'perm-1'))

  assert.equal(a.collapsed, true)
  assert.equal(a.working, 1)
  assert.equal(worktreeAttentionTotal(a), 1)
})

import { strict as assert } from 'node:assert'
import { test } from 'vitest'
import {
  createSessionCanvasNode,
  createWorktreeCanvasNode,
  type CanvasNode,
  type TerminalCanvasNode,
  type WorktreeCanvasNode
} from '../src/renderer/src/canvas-workspace'
import { userVisibleAttention } from '../src/renderer/src/workspace-attention'
import { recordAttention, type AttentionKind, type AttentionState } from '../src/shared/attention'
import type { WorkspaceProject } from '../src/shared/workspace'

const ALL_KINDS: readonly AttentionKind[] = ['approval', 'auth', 'result', 'failure', 'output']

const TOUCAN: WorkspaceProject = { id: 'toucan', name: 'Toucan', path: 'D:\\Development\\toucan', color: '#8ab4f8' }

const noop = (): undefined => undefined
const callbacks = {
  onStatusChange: noop,
  onConversationId: noop,
  onTitleChange: async () => true,
  onFocusModeChange: noop,
  onDraftChange: noop,
  onPermissionModeChange: noop,
  onModelChange: noop,
  onResume: noop,
  onRemoveWorktree: noop,
  onCreateNodeInWorktree: noop,
  onRunSetupCommand: noop,
  onOpenDiff: noop,
  onViewportChange: noop,
  onToggleCollapsed: noop
}

function worktree(worktreeId: string): WorktreeCanvasNode {
  return createWorktreeCanvasNode(
    {
      worktreeId,
      branch: `ticket/${worktreeId}`,
      path: `D:\\Worktrees\\${worktreeId}`,
      baseRef: 'main',
      createdAt: '2026-09-09T09:00:00.000Z',
      position: { x: 0, y: 0 }
    },
    TOUCAN,
    callbacks
  )
}

function chat(
  id: string,
  options: { in?: WorktreeCanvasNode; role?: 'orchestrator'; orchestratedBy?: string } = {}
): TerminalCanvasNode {
  return createSessionCanvasNode(
    {
      id,
      kind: 'claude',
      label: id,
      position: { x: 0, y: 0 },
      launchMode: 'new',
      role: options.role,
      orchestratedBy: options.orchestratedBy
        ? { nodeId: options.orchestratedBy, conversationId: `conv-${options.orchestratedBy}`, provider: 'claude' }
        : undefined
    },
    TOUCAN,
    options.in?.data,
    callbacks
  )
}

function raiseAll(nodeId: string, state: AttentionState = []): AttentionState {
  return ALL_KINDS.reduce((acc, kind) => recordAttention(acc, { nodeId, kind, at: 1 }), state)
}

const kindsOf = (state: AttentionState, nodeId: string): AttentionKind[] =>
  state.filter((item) => item.nodeId === nodeId).map((item) => item.kind)

const ticket = worktree('1')
const nodes: CanvasNode[] = [
  chat('orch', { role: 'orchestrator' }),
  ticket,
  chat('ticket-chat', { in: ticket, orchestratedBy: 'orch' }),
  chat('plain-chat')
]

test('an orchestrator-owned chat keeps only approval and auth attention', () => {
  const visible = userVisibleAttention(raiseAll('ticket-chat'), nodes)
  assert.deepEqual(kindsOf(visible, 'ticket-chat'), ['approval', 'auth'])
})

test('chats not owned by an orchestrator, including the orchestrator itself, keep every kind', () => {
  const records = raiseAll('plain-chat', raiseAll('orch'))
  const visible = userVisibleAttention(records, nodes)
  assert.deepEqual(kindsOf(visible, 'orch'), [...ALL_KINDS])
  assert.deepEqual(kindsOf(visible, 'plain-chat'), [...ALL_KINDS])
  assert.equal(visible, records)
})

test('each hidden kind is dropped and each kept kind survives on its own', () => {
  for (const kind of ALL_KINDS) {
    const visible = userVisibleAttention(recordAttention([], { nodeId: 'ticket-chat', kind, at: 1 }), nodes)
    assert.equal(visible.length, ['approval', 'auth'].includes(kind) ? 1 : 0, kind)
  }
})

test('a ticket chat whose orchestrator is gone is not filtered', () => {
  const orphaned = nodes.filter((node) => node.id !== 'orch')
  const records = raiseAll('ticket-chat')
  assert.equal(userVisibleAttention(records, orphaned), records)
})

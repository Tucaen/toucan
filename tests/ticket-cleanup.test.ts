import { strict as assert } from 'node:assert'
import { test } from 'vitest'
import type { TicketCleanupRequest } from '../src/shared/orchestration-cleanup'
import type { CanvasNode } from '../src/renderer/src/canvas-workspace'
import { ticketCleanupNodes } from '../src/renderer/src/ticket-cleanup'

const request: TicketCleanupRequest = {
  projectPath: 'D:\\project',
  session: {
    nodeId: 'ticket-node',
    conversationId: 'ticket-conversation',
    worktreePath: 'D:\\ticket-1',
    branch: 'ticket/1'
  },
  phase: 'retire'
}

const nodes = [
  {
    id: 'worktree-node',
    type: 'worktreeNode',
    data: {
      worktreeId: 'worktree-1',
      projectPath: request.projectPath,
      path: request.session.worktreePath,
      branch: request.session.branch
    }
  },
  {
    id: request.session.nodeId,
    type: 'terminalNode',
    data: {
      kind: 'claude',
      conversationId: request.session.conversationId,
      worktreeId: 'worktree-1',
      dormant: false
    }
  },
  {
    id: 'open-file',
    type: 'fileNode',
    data: { worktreeId: 'worktree-1' }
  }
] as CanvasNode[]

test('an open file blocks worktree removal but not retirement of the merged ticket session', () => {
  assert.deepEqual(ticketCleanupNodes(request, nodes, { 'ticket-node': 'idle' }), {
    ok: true,
    suspendId: 'ticket-node'
  })
  assert.deepEqual(ticketCleanupNodes({ ...request, phase: 'prepare' }, nodes, {}), {
    ok: false,
    message: 'Another session or file editor is using the ticket worktree.'
  })
})

test('a busy ticket still refuses retirement', () => {
  assert.deepEqual(ticketCleanupNodes(request, nodes, { 'ticket-node': 'working' }), {
    ok: false,
    message: 'The ticket session is busy or waiting for an answer.'
  })
})

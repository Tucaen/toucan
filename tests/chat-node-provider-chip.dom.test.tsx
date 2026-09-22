import { ReactFlowProvider } from '@xyflow/react'
import { render } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import type { WorkspaceState } from '../src/shared/terminal'
import ChatNode from '../src/renderer/src/ChatNode'
import {
  isTerminalCanvasNode,
  restoreCanvasWorkspace,
  type TerminalNodeCallbacks,
  type WorktreeNodeCallbacks
} from '../src/renderer/src/canvas-workspace'
import { createMockAgentApi } from './dom/agent-api-mock'

// Which agent a conversation runs on is fixed for the session's life, so it reads in the node
// header beside the rest of the node's identity rather than as a chip among the composer's
// pickers, which are the things a turn actually changes.

const callbacks: TerminalNodeCallbacks & WorktreeNodeCallbacks = {
  onStatusChange: vi.fn(),
  onConversationId: vi.fn(),
  onTitleChange: vi.fn(async () => true),
  onFocusModeChange: vi.fn(),
  onDraftChange: vi.fn(),
  onPermissionModeChange: vi.fn(),
  onModelChange: vi.fn(),
  onResume: vi.fn(),
  onRemoveWorktree: vi.fn(),
  onCreateNodeInWorktree: vi.fn(),
  onRunSetupCommand: vi.fn()
}

test('the node header names the provider, and the composer no longer repeats it', () => {
  window.agentApi = createMockAgentApi().api
  const state: WorkspaceState = {
    version: 3,
    projects: [{ id: 'project-1', name: 'Toucan', path: '/project', color: '#71a9ff' }],
    activeProjectId: 'project-1',
    sidebarCollapsed: false,
    nodes: [
      {
        id: 'chat-1',
        kind: 'claude',
        label: 'Claude 1',
        projectId: 'project-1',
        position: { x: 0, y: 0 },
        width: 640,
        height: 480,
        focusMode: false
      }
    ],
    worktrees: []
  }
  const node = restoreCanvasWorkspace(state, callbacks).nodes.find(isTerminalCanvasNode)
  if (!node) throw new Error('Expected the saved chat node to restore.')

  const { container } = render(
    <ReactFlowProvider>
      <ChatNode
        id={node.id}
        data={node.data}
        type="terminalNode"
        dragging={false}
        zIndex={0}
        selectable
        deletable
        selected={false}
        draggable
        isConnectable={false}
        positionAbsoluteX={0}
        positionAbsoluteY={0}
      />
    </ReactFlowProvider>
  )

  expect(container.querySelector('.chat-node-header .node-provider')).toHaveTextContent('Claude')
  expect(container.querySelector('.composer-toolbar')).not.toHaveTextContent('Claude')
})

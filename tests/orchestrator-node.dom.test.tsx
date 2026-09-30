import { ReactFlowProvider } from '@xyflow/react'
import { render, waitFor } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import type { WorkspaceState } from '../src/shared/workspace'
import ChatNode from '../src/renderer/src/ChatNode'
import {
  isTerminalCanvasNode,
  restoreCanvasWorkspace,
  type TerminalNodeCallbacks,
  type WorktreeNodeCallbacks
} from '../src/renderer/src/canvas-workspace'
import { createMockAgentApi } from './dom/agent-api-mock'

// #33: an orchestrator reads as one in its header, and its launch asks main for the orchestrator
// role - an ordinary chat asks for none.

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

function renderChat(role?: 'orchestrator') {
  const mock = createMockAgentApi()
  window.agentApi = mock.api
  const state: WorkspaceState = {
    version: 3,
    projects: [{ id: 'project-1', name: 'Toucan', path: '/project', color: '#71a9ff' }],
    activeProjectId: 'project-1',
    sidebarCollapsed: false,
    nodes: [
      {
        id: 'chat-1',
        kind: 'claude',
        label: role ? 'Orchestrator 1' : 'Claude 1',
        projectId: 'project-1',
        position: { x: 0, y: 0 },
        width: 640,
        height: 480,
        focusMode: false,
        ...(role ? { role } : {})
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
  return { container, create: vi.mocked(mock.api.create) }
}

test('an orchestrator carries its badge and launches asking for the orchestrator role', async () => {
  const { container, create } = renderChat('orchestrator')

  expect(container.querySelector('.chat-node-header .node-orchestrator-badge')).toHaveTextContent('Orchestrator')
  await waitFor(() => expect(create).toHaveBeenCalled())
  expect(create.mock.calls[0]?.[0]).toMatchObject({ provider: 'claude', role: 'orchestrator' })
})

test('an ordinary chat has no badge and asks for no role', async () => {
  const { container, create } = renderChat()

  expect(container.querySelector('.node-orchestrator-badge')).toBeNull()
  await waitFor(() => expect(create).toHaveBeenCalled())
  expect(create.mock.calls[0]?.[0]).not.toHaveProperty('role')
})

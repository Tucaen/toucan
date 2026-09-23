import { ReactFlowProvider } from '@xyflow/react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import type { WorkspaceState } from '../src/shared/workspace'
import ChatNode from '../src/renderer/src/ChatNode'
import {
  isTerminalCanvasNode,
  restoreCanvasWorkspace,
  type TerminalCanvasNode,
  type TerminalNodeCallbacks,
  type TerminalNodeData,
  type WorktreeNodeCallbacks
} from '../src/renderer/src/canvas-workspace'
import { createMockAgentApi } from './dom/agent-api-mock'

// An `exited` chat node (#240): the adapter is gone, typing leads nowhere, and before this the
// only way back was close + History - which dropped lineage, model and geometry.

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

function chatNode(): TerminalCanvasNode {
  const state: WorkspaceState = {
    version: 3,
    projects: [{ id: 'project-1', name: 'Toucan', path: '/project', color: '#71a9ff' }],
    activeProjectId: 'project-1',
    sidebarCollapsed: false,
    nodes: [
      {
        id: 'chat-node',
        kind: 'codex',
        label: 'Codex 1',
        projectId: 'project-1',
        position: { x: 0, y: 0 },
        width: 640,
        height: 480,
        focusMode: false,
        conversationId: 'thread-1'
      }
    ],
    worktrees: []
  }
  const node = restoreCanvasWorkspace(state, callbacks).nodes.find(isTerminalCanvasNode)
  if (!node) throw new Error('Expected the saved chat node to restore.')
  return { ...node, data: { ...node.data, dormant: false } }
}

function view(node: TerminalCanvasNode, data: Partial<TerminalNodeData>): JSX.Element {
  return (
    <ReactFlowProvider>
      <ChatNode
        id={node.id}
        data={{ ...node.data, ...data }}
        type="terminalNode"
        dragging={false}
        zIndex={0}
        selectable
        deletable
        selected={false}
        width={640}
        draggable
        isConnectable={false}
        positionAbsoluteX={0}
        positionAbsoluteY={0}
      />
    </ReactFlowProvider>
  )
}

const resumeAction = (): HTMLElement | null => screen.queryByRole('button', { name: 'Resume conversation' })

describe('an exited chat node', () => {
  test('offers Resume in place, and hands it up to the workspace', async () => {
    const agent = createMockAgentApi()
    window.agentApi = agent.api
    const onResume = vi.fn()
    render(view(chatNode(), { onResume }))

    await waitFor(() => expect(agent.api.create).toHaveBeenCalled())
    expect(resumeAction()).toBeNull()
    agent.emit('chat-node', { type: 'status', status: 'exited', message: 'ACP adapter exited with code 1.' })

    await waitFor(() => expect(resumeAction()).toBeEnabled())
    fireEvent.click(resumeAction()!)
    expect(onResume).toHaveBeenCalledWith('chat-node')
  })

  test('relaunches its session when the workspace bumps the relaunch nonce', async () => {
    const agent = createMockAgentApi()
    window.agentApi = agent.api
    const node = chatNode()
    const { rerender } = render(view(node, {}))
    await waitFor(() => expect(agent.api.create).toHaveBeenCalledTimes(1))

    rerender(view(node, { relaunchNonce: 1 }))

    await waitFor(() => expect(agent.api.create).toHaveBeenCalledTimes(2))
    expect(agent.api.create).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId: 'thread-1' }))
  })
})

import { ReactFlowProvider } from '@xyflow/react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import type { AgentProvider } from '../src/shared/agent'
import type { WorkspaceState } from '../src/shared/terminal'
import ChatNode from '../src/renderer/src/ChatNode'
import {
  isTerminalCanvasNode,
  restoreCanvasWorkspace,
  type TerminalCanvasNode,
  type TerminalNodeCallbacks,
  type WorktreeNodeCallbacks
} from '../src/renderer/src/canvas-workspace'
import { createMockAgentApi } from './dom/agent-api-mock'

const callbacks: TerminalNodeCallbacks & WorktreeNodeCallbacks = {
  onStatusChange: vi.fn(),
  onConversationId: vi.fn(),
  onTitleChange: vi.fn(async () => true),
  onPreview: vi.fn(),
  onFocusModeChange: vi.fn(),
  onDraftChange: vi.fn(),
  onPermissionModeChange: vi.fn(),
  onModelChange: vi.fn(),
  onResume: vi.fn(),
  onRemoveWorktree: vi.fn(),
  onCreateNodeInWorktree: vi.fn(),
  onRunSetupCommand: vi.fn()
}

function restoredChat(provider: AgentProvider): TerminalCanvasNode {
  const state: WorkspaceState = {
    version: 3,
    projects: [{ id: 'project-1', name: 'Toucan', path: '/project', color: '#71a9ff' }],
    activeProjectId: 'project-1',
    sidebarCollapsed: false,
    nodes: [
      {
        id: `${provider}-node`,
        kind: provider,
        label: provider === 'claude' ? 'Claude 1' : 'Codex 1',
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        position: { x: 120, y: 80 },
        width: 640,
        height: 480,
        focusMode: false,
        conversationId: `${provider}-conversation`
      }
    ],
    worktrees: [
      {
        id: 'worktree-1',
        projectId: 'project-1',
        branch: 'fix/transcript-restore',
        path: '/project-worktree',
        baseRef: 'main',
        createdAt: '2026-08-30T00:00:00.000Z',
        position: { x: 20, y: 20 },
        width: 360,
        height: 232
      }
    ]
  }
  const restored = restoreCanvasWorkspace(state, callbacks)
  const node = restored.nodes.find(isTerminalCanvasNode)
  if (!node) throw new Error('Expected the saved chat node to restore.')
  return node
}

function renderNode(node: TerminalCanvasNode): void {
  render(
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
        width={node.style?.width as number}
        height={node.style?.height as number}
        isConnectable={false}
        positionAbsoluteX={node.position.x}
        positionAbsoluteY={node.position.y}
      />
    </ReactFlowProvider>
  )
}

describe.each(['claude', 'codex'] as const)('%s restored chat transcript', (provider) => {
  test('reuses the saved conversation and renders replay before any new prompt', async () => {
    const mock = createMockAgentApi({
      create: vi.fn(async (request) => {
        return {
          ok: true,
          status: 'ready',
          sessionId: request.sessionId,
          replay: [
            {
              type: 'message',
              role: 'user',
              messageId: 'saved-user-message',
              text: 'Persisted question'
            },
            {
              type: 'message',
              role: 'assistant',
              messageId: 'saved-progress-message',
              text: 'Reading the saved workspace.',
              ...(provider === 'codex' ? { presentation: 'progress' as const } : {})
            },
            {
              type: 'message',
              role: 'assistant',
              messageId: 'saved-assistant-message',
              text: 'Persisted answer',
              ...(provider === 'codex' ? { presentation: 'final' as const } : {})
            }
          ]
        }
      })
    })
    window.agentApi = mock.api

    const node = restoredChat(provider)
    expect(node.position).toEqual({ x: 120, y: 80 })
    expect(node.style).toMatchObject({ width: 640, height: 480 })
    expect(node.data.worktreeId).toBe('worktree-1')
    expect(node.data.workingDirectory).toBe('/project-worktree')

    renderNode(node)

    await waitFor(() => expect(screen.getByText('Persisted question')).toBeInTheDocument())
    expect(screen.getByRole('button', { name: 'Fit to canvas' }).closest('header')).toHaveClass('chat-node-header')
    const progress = screen.getByText('Reading the saved workspace.').closest('article')
    expect(progress).toHaveAttribute('data-presentation', 'progress')
    expect(screen.getByText('Progress')).toBeInTheDocument()
    expect(screen.getByText('Persisted answer').closest('article')).toHaveAttribute('data-presentation', 'final')
    expect(mock.api.create).toHaveBeenCalledWith(
      expect.objectContaining({
        provider,
        cwd: '/project-worktree',
        sessionId: `${provider}-conversation`
      })
    )
    expect(mock.api.prompt).not.toHaveBeenCalled()
    expect(mock.api.promptWhenIdle).not.toHaveBeenCalled()
  })
})

test('renames a conversation from its node header and marks the title manual', async () => {
  const mock = createMockAgentApi({
    create: vi.fn(async (request) => ({ ok: true, status: 'ready', sessionId: request.sessionId }))
  })
  window.agentApi = mock.api
  const node = restoredChat('codex')
  node.data.titleSource = 'generated'
  renderNode(node)

  fireEvent.click(await screen.findByRole('button', { name: 'Rename conversation' }))
  const input = screen.getByRole('textbox', { name: 'Conversation title' })
  fireEvent.change(input, { target: { value: 'Durable conversation titles' } })
  fireEvent.keyDown(input, { key: 'Enter' })

  expect(callbacks.onTitleChange).toHaveBeenCalledWith('codex-node', 'Durable conversation titles', 'manual')
})

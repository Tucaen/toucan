import { ReactFlowProvider } from '@xyflow/react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactElement } from 'react'
import { describe, expect, test, vi } from 'vitest'
import type { WorkspaceState } from '../src/shared/terminal'
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

// The Branch action as the node presents it: absent where a fork cannot work, disabled while the
// transcript it would copy is mid-flight, and - when it does run - a launch that forks the parent's
// conversation rather than resuming anything.

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

function chatNode(overrides: Partial<WorkspaceState['nodes'][number]> = {}): TerminalCanvasNode {
  const state: WorkspaceState = {
    version: 3,
    projects: [{ id: 'project-1', name: 'Toucan', path: '/project', color: '#71a9ff' }],
    activeProjectId: 'project-1',
    sidebarCollapsed: false,
    nodes: [
      {
        id: 'chat-node',
        kind: 'claude',
        label: 'Claude 1',
        projectId: 'project-1',
        position: { x: 0, y: 0 },
        width: 640,
        height: 480,
        focusMode: false,
        conversationId: 'conversation-parent',
        ...overrides
      }
    ],
    worktrees: []
  }
  const node = restoreCanvasWorkspace(state, callbacks).nodes.find(isTerminalCanvasNode)
  if (!node) throw new Error('Expected the saved chat node to restore.')
  return node
}

function nodeView(node: TerminalCanvasNode, data: Partial<TerminalNodeData> = {}): ReactElement {
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

const branchAction = (): HTMLElement | null => screen.queryByRole('button', { name: 'Branch conversation' })

describe('the chat node Branch action', () => {
  test('appears on an idle Claude conversation and hands the branch up to the workspace', async () => {
    window.agentApi = createMockAgentApi().api
    const onBranch = vi.fn()
    const node = chatNode()

    render(nodeView(node, { onBranch }))

    await waitFor(() => expect(branchAction()).toBeEnabled())
    fireEvent.click(branchAction()!)
    expect(onBranch).toHaveBeenCalledWith('chat-node')
  })

  test('is absent where a fork cannot work: a Codex node, and a session that reported no capability', () => {
    window.agentApi = createMockAgentApi().api

    render(nodeView(chatNode({ kind: 'codex' })))
    expect(branchAction()).toBeNull()
    screen.getByText('Claude 1') // the node itself rendered; only the action is missing

    render(nodeView(chatNode(), { forkSupport: false }))
    expect(branchAction()).toBeNull()
  })

  test('is disabled with a reason while the session is not at a turn boundary', async () => {
    // A create that never settles holds the node at `starting`, the same gate a running turn hits.
    window.agentApi = createMockAgentApi({ create: vi.fn(() => new Promise(() => {})) }).api

    render(nodeView(chatNode()))

    expect(branchAction()).toBeDisabled()
    expect(branchAction()).toHaveAttribute('title', expect.stringContaining('turn'))
  })

  test('a branched node launches as a fork of its parent, resuming nothing', async () => {
    const agent = createMockAgentApi()
    window.agentApi = agent.api
    const node = chatNode()

    render(
      nodeView(node, {
        conversationId: undefined,
        launchMode: 'fork',
        branchedFrom: { nodeId: 'parent-node', conversationId: 'conversation-parent' }
      })
    )

    await waitFor(() => expect(agent.api.create).toHaveBeenCalled())
    expect(agent.api.create).toHaveBeenCalledWith(
      expect.objectContaining({ forkFromSessionId: 'conversation-parent', sessionId: undefined })
    )
  })
  test('a fork is one-shot: the workspace flips the child to resume as soon as it owns a conversation', async () => {
    const agent = createMockAgentApi()
    window.agentApi = agent.api
    const onConversationId = vi.fn()

    render(
      nodeView(chatNode(), {
        conversationId: undefined,
        launchMode: 'fork',
        branchedFrom: { nodeId: 'parent-node', conversationId: 'conversation-parent' },
        onConversationId
      })
    )

    await waitFor(() => expect(agent.api.create).toHaveBeenCalled())
    agent.emit('chat-node', { type: 'session', sessionId: 'conversation-child' })

    // The workspace is what flips `launchMode`; the node's part is reporting the id it was given,
    // which is the child's own - never the parent's, or a restart would re-fork.
    await waitFor(() => expect(onConversationId).toHaveBeenCalledWith('chat-node', 'conversation-child'))
  })
})

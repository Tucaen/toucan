import { ReactFlowProvider } from '@xyflow/react'
import { render, screen, waitFor } from '@testing-library/react'
import type { ReactElement } from 'react'
import { describe, expect, test, vi } from 'vitest'
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

// Where the caret lands when a chat node opens. The composer is disabled while the session starts,
// so the interesting part is that the focus waits for the session and still only ever goes to the
// node the open acted on - never to the crowd of conversations a workspace reload brings back.

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

function chatNode(id: string): TerminalCanvasNode {
  const state: WorkspaceState = {
    version: 3,
    projects: [{ id: 'project-1', name: 'Toucan', path: '/project', color: '#71a9ff' }],
    activeProjectId: 'project-1',
    sidebarCollapsed: false,
    nodes: [
      {
        id,
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
  return node
}

/** One chat node rendered the way the canvas renders it, with only the two inputs an open moves. */
function nodeView(node: TerminalCanvasNode, options: { selected: boolean; dormant?: boolean }): ReactElement {
  return (
    <ReactFlowProvider>
      <ChatNode
        id={node.id}
        data={{ ...node.data, dormant: options.dormant ?? false }}
        type="terminalNode"
        dragging={false}
        zIndex={0}
        selectable
        deletable
        selected={options.selected}
        draggable
        isConnectable={false}
        positionAbsoluteX={0}
        positionAbsoluteY={0}
      />
    </ReactFlowProvider>
  )
}

function composer(): HTMLTextAreaElement {
  return screen.getByPlaceholderText('Message the agent...') as HTMLTextAreaElement
}

describe('chat node open focus', () => {
  test('a node opened on the canvas takes the caret once its session is ready', async () => {
    window.agentApi = createMockAgentApi().api
    const node = chatNode('opened-node')

    render(nodeView(node, { selected: true }))

    // Nothing to focus yet: the composer is disabled while the session starts.
    expect(composer()).toBeDisabled()
    expect(composer()).not.toHaveFocus()
    await waitFor(() => expect(composer()).toHaveFocus())
  })

  test('a conversation restored by a workspace reload leaves the caret alone', async () => {
    window.agentApi = createMockAgentApi().api
    const node = chatNode('hydrated-node')

    const view = render(nodeView(node, { selected: false }))

    await waitFor(() => expect(composer()).not.toBeDisabled())
    expect(composer()).not.toHaveFocus()

    // Selecting it later is not an open either - a click on the node body must not move the caret.
    view.rerender(nodeView(node, { selected: true }))
    expect(composer()).not.toHaveFocus()
  })

  test('resuming a saved conversation moves the caret into its composer', async () => {
    window.agentApi = createMockAgentApi().api
    const node = chatNode('resumed-node')

    const view = render(nodeView(node, { selected: false, dormant: true }))

    expect(screen.getByRole('button', { name: 'Start conversation' })).toBeTruthy()

    view.rerender(nodeView(node, { selected: true }))

    await waitFor(() => expect(composer()).toHaveFocus())
  })
})

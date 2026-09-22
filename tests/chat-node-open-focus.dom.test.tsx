import { ReactFlowProvider } from '@xyflow/react'
import { render, screen, waitFor } from '@testing-library/react'
import type { ReactElement } from 'react'
import { describe, expect, test, vi } from 'vitest'
import type { WorkspaceState } from '../src/shared/workspace'
import ChatNode from '../src/renderer/src/ChatNode'
import {
  isTerminalCanvasNode,
  restoreCanvasWorkspace,
  type TerminalCanvasNode,
  type TerminalNodeCallbacks,
  type WorktreeNodeCallbacks
} from '../src/renderer/src/canvas-workspace'
import { createMockAgentApi } from './dom/agent-api-mock'

// Where the caret lands when a chat node opens. The composer takes input from its first render, so
// the interesting parts are that the caret only ever goes to the node the open acted on - never to
// the crowd of conversations a workspace reload brings back - and that a request which lands on
// nothing, because React Flow has not measured the node into view yet, is not spent.

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
function nodeView(
  node: TerminalCanvasNode,
  options: { selected: boolean; dormant?: boolean; width?: number }
): ReactElement {
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
        width={options.width}
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
  test('a node opened on the canvas takes the caret while its session is still starting', () => {
    window.agentApi = createMockAgentApi().api
    const node = chatNode('opened-node')

    render(nodeView(node, { selected: true }))

    // The caret lands with the node, not with the session: a prompt can be typed through the
    // whole handshake. Only the send waits for the session that will carry it.
    expect(composer()).toBeEnabled()
    expect(composer()).toHaveFocus()
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()
  })

  test('a node still waiting to be measured keeps its caret request instead of spending it', () => {
    window.agentApi = createMockAgentApi().api
    const node = chatNode('unmeasured-node')

    // React Flow renders a node `visibility: hidden` until it has measured it, and a hidden element
    // silently refuses focus. jsdom has no layout, so that refusal is stubbed here: the attempt on
    // the mount - the one that runs before the measuring pass - lands on nothing, as it does on the
    // canvas. The request has to survive it.
    const focus = vi.spyOn(HTMLTextAreaElement.prototype, 'focus').mockImplementation(() => {})
    const view = render(nodeView(node, { selected: true }))
    expect(composer()).not.toHaveFocus()

    // The measurement is what makes the node visible, and `width` is what it reports.
    focus.mockRestore()
    view.rerender(nodeView(node, { selected: true, width: 640 }))

    expect(composer()).toHaveFocus()
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

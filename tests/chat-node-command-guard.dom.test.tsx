import { ReactFlowProvider } from '@xyflow/react'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import type { WorkspaceState } from '../src/shared/workspace'
import ChatNode from '../src/renderer/src/ChatNode'
import {
  isTerminalCanvasNode,
  restoreCanvasWorkspace,
  type TerminalNodeCallbacks,
  type WorktreeNodeCallbacks
} from '../src/renderer/src/canvas-workspace'
import { CommandGuardGloballyOffContext } from '../src/renderer/src/command-guard-context'
import { createMockAgentApi } from './dom/agent-api-mock'

// Ticket 03 feeds ticket 04's per-node switch: while the user has the guard off for every new
// session, a chat node's own switch shows off and cannot be changed.

const callbacks: TerminalNodeCallbacks & WorktreeNodeCallbacks = {
  onStatusChange: vi.fn(),
  onConversationId: vi.fn(),
  onTitleChange: vi.fn(async () => true),
  onFocusModeChange: vi.fn(),
  onDraftChange: vi.fn(),
  onPermissionModeChange: vi.fn(),
  onModelChange: vi.fn(),
  onCommandGuardChange: vi.fn(),
  onResume: vi.fn(),
  onRemoveWorktree: vi.fn(),
  onCreateNodeInWorktree: vi.fn(),
  onRunSetupCommand: vi.fn()
}

function renderChat(globallyOff: boolean): HTMLElement {
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
    <CommandGuardGloballyOffContext.Provider value={globallyOff}>
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
    </CommandGuardGloballyOffContext.Provider>
  )
  fireEvent.click(container.querySelector('.composer-settings-button') as HTMLElement)
  const panels = screen.getAllByRole('group', { name: 'More settings' })
  return panels[panels.length - 1]
}

const guardTrigger = (panel: HTMLElement): HTMLElement =>
  within(panel.querySelector('[data-picker="commandGuard"]') as HTMLElement).getByRole('button')

test('a chat node follows the global switch: off everywhere locks its own switch off', () => {
  const panel = renderChat(true)
  expect(guardTrigger(panel)).toHaveTextContent(/off/i)
  expect(guardTrigger(panel)).toBeDisabled()
})

test('with the guard on globally the node keeps its own switch', () => {
  const panel = renderChat(false)
  expect(guardTrigger(panel)).toBeEnabled()
})

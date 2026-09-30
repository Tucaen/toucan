import { ReactFlowProvider } from '@xyflow/react'
import { fireEvent, render, waitFor } from '@testing-library/react'
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

function renderChat(role?: 'orchestrator', conversationId?: string) {
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
        ...(conversationId ? { conversationId } : {}),
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
  return { container, create: vi.mocked(mock.api.create), cancel: vi.mocked(mock.api.cancel) }
}

test('an orchestrator carries its badge and launches asking for the orchestrator role', async () => {
  window.orchestratorApi = {
    onStartTicketSession: () => () => undefined,
    completeTicketSession: vi.fn(),
    jevReachability: vi.fn(async () => ({ state: 'reachable' as const }))
  }
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

// #36: before its task is sent, an orchestrator shows whether Jev can route its tickets.

test('an orchestrator shows before its task whether Jev is reachable', async () => {
  window.orchestratorApi = {
    onStartTicketSession: () => () => undefined,
    completeTicketSession: vi.fn(),
    jevReachability: vi.fn(async () => ({ state: 'no-key' as const }))
  }
  const { container } = renderChat('orchestrator')
  await waitFor(() => expect(container.querySelector('.node-jev-reachability')).toHaveTextContent('Jev unavailable'))
  expect(container.querySelector('.node-jev-reachability')).toHaveAttribute(
    'title',
    expect.stringMatching(/TYPESAFE_API_KEY/)
  )
})

test('a reachable Jev says so, and an ordinary chat never asks', async () => {
  const jevReachability = vi.fn(async () => ({ state: 'reachable' as const }))
  window.orchestratorApi = {
    onStartTicketSession: () => () => undefined,
    completeTicketSession: vi.fn(),
    jevReachability
  }
  const orchestrator = renderChat('orchestrator')
  await waitFor(() =>
    expect(orchestrator.container.querySelector('.node-jev-reachability')).toHaveTextContent('Jev reachable')
  )
  orchestrator.container.remove()
  jevReachability.mockClear()
  const chat = renderChat()
  await waitFor(() => expect(chat.create).toHaveBeenCalled())
  expect(chat.container.querySelector('.node-jev-reachability')).toBeNull()
  expect(jevReachability).not.toHaveBeenCalled()
})

test('a paused orchestrator shows its reset and Resume now, while Stop orchestration stops the whole run', async () => {
  const reset = Date.parse('2026-09-30T15:00:00.000Z')
  const resumeOrchestration = vi.fn(async (request) => ({
    provider: request.provider,
    conversationId: request.conversationId,
    status: 'running' as const
  }))
  const stopOrchestration = vi.fn(async (request) => ({
    provider: request.provider,
    conversationId: request.conversationId,
    status: 'stopped' as const
  }))
  window.orchestratorApi = {
    onStartTicketSession: () => () => undefined,
    completeTicketSession: vi.fn(),
    jevReachability: vi.fn(async () => ({ state: 'reachable' as const })),
    orchestrationState: vi.fn(async () => ({
      provider: 'claude' as const,
      conversationId: 'conversation-1',
      status: 'paused' as const,
      resetsAt: reset
    })),
    resumeOrchestration,
    stopOrchestration,
    onOrchestrationState: () => () => undefined
  }

  const { container, cancel } = renderChat('orchestrator', 'conversation-1')
  await waitFor(() => expect(container.querySelector('.node-orchestration-paused')).toHaveTextContent('Paused until'))
  const resume = container.querySelector('.node-orchestration-resume') as HTMLButtonElement
  expect(resume).toHaveTextContent('Resume now')
  fireEvent.click(resume)
  await waitFor(() =>
    expect(resumeOrchestration).toHaveBeenCalledWith({
      provider: 'claude',
      conversationId: 'conversation-1',
      nodeId: 'chat-1'
    })
  )

  const stop = await waitFor(() => container.querySelector('.node-orchestration-stop') as HTMLButtonElement)
  expect(stop).toHaveTextContent('Stop orchestration')
  fireEvent.click(stop)
  await waitFor(() => expect(stopOrchestration).toHaveBeenCalled())
  expect(cancel).not.toHaveBeenCalled()
  await waitFor(() => expect(container.querySelector('.node-orchestration-stopped')).toHaveTextContent('Stopped'))
})

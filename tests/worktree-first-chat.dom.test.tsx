import { ReactFlowProvider } from '@xyflow/react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactElement } from 'react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { AgentProvider } from '../src/shared/agent-provider'
import type { WorkspaceProject } from '../src/shared/workspace'
import type { WorktreeApi } from '../src/shared/worktree'
import ChatNode from '../src/renderer/src/ChatNode'
import WorktreeNode from '../src/renderer/src/WorktreeNode'
import {
  createSessionCanvasNode,
  createWorktreeCanvasNode,
  isTerminalCanvasNode,
  isWorktreeCanvasNode,
  type CanvasNode,
  type TerminalCanvasNode,
  type TerminalNodeCallbacks,
  type WorktreeCanvasNode,
  type WorktreeNodeCallbacks,
  type WorktreeNodeData
} from '../src/renderer/src/canvas-workspace'
import { registerWorktreeNode } from '../src/renderer/src/worktree-attachment'
import { createWorktreeCreator } from '../src/renderer/src/worktree-creation'
import { createMockAgentApi } from './dom/agent-api-mock'

/**
 * The worktree dialog's one action, carried past the dialog: git creates the checkout, the real
 * node builders put the worktree and its first chat on a canvas, and the chat node is rendered the
 * way the canvas renders it - so what reaches the agent bridge is the cwd and provider the session
 * actually launches with, not a value a harness passed along.
 */

const PROJECT: WorkspaceProject = { id: 'project-1', name: 'Toucan', path: 'D:\\Development\\toucan', color: '#8ab4f8' }
const WORKTREE_PATH = 'D:\\Development\\toucan-worktrees\\feature-login'

const sessionCallbacks: TerminalNodeCallbacks = {
  onStatusChange: vi.fn(),
  onConversationId: vi.fn(),
  onTitleChange: vi.fn(async () => true),
  onFocusModeChange: vi.fn(),
  onDraftChange: vi.fn(),
  onPermissionModeChange: vi.fn(),
  onModelChange: vi.fn(),
  onResume: vi.fn()
}

function worktreeCallbacks(): WorktreeNodeCallbacks {
  return { onRemoveWorktree: vi.fn(), onCreateNodeInWorktree: vi.fn(), onRunSetupCommand: vi.fn(), onOpenDiff: vi.fn() }
}

function stubWorktreeApi(): WorktreeApi['create'] {
  const create = vi.fn<WorktreeApi['create']>(async (request) => ({
    ok: true,
    worktree: { path: WORKTREE_PATH, branch: request.branch, baseRef: 'main' }
  }))
  window.worktreeApi = {
    create,
    status: vi.fn(async () => ({
      exists: true,
      changedFiles: 0,
      untrackedFiles: 0,
      stashEntries: 0,
      ahead: 0,
      behind: 0,
      hasUpstream: false
    }))
  } as unknown as WorktreeApi
  return create
}

/** A canvas reduced to its node list, driven by the creator exactly as the workspace drives it. */
async function createWithFirstChat(provider: AgentProvider, callbacks = worktreeCallbacks()): Promise<CanvasNode[]> {
  let nodes: CanvasNode[] = []
  const creator = createWorktreeCreator<WorktreeNodeData>({
    create: (request) => window.worktreeApi.create(request),
    register: (created) => {
      const node = createWorktreeCanvasNode(
        {
          worktreeId: 'worktree-1',
          branch: created.branch,
          path: created.path,
          baseRef: created.baseRef,
          createdAt: '2026-09-28T00:00:00.000Z',
          position: { x: 0, y: 0 }
        },
        PROJECT,
        callbacks
      )
      nodes = registerWorktreeNode(nodes, node)
      return node.data
    },
    startChat: (worktree, chosen) => {
      const node = createSessionCanvasNode(
        { id: 'chat-1', kind: chosen, label: 'Chat 1', position: { x: 408, y: 0 }, launchMode: 'new' },
        PROJECT,
        worktree,
        sessionCallbacks
      )
      nodes = [...nodes, node]
      return node.id
    }
  })
  const outcome = await creator.submit({ projectPath: PROJECT.path, branch: 'feature/login', provider })
  expect(outcome?.status).toBe('created')
  return nodes
}

function chatView(node: TerminalCanvasNode): ReactElement {
  return (
    <ReactFlowProvider>
      <ChatNode
        id={node.id}
        data={node.data}
        type="terminalNode"
        dragging={false}
        zIndex={0}
        selectable
        deletable
        selected={node.selected ?? false}
        draggable
        isConnectable={false}
        positionAbsoluteX={0}
        positionAbsoluteY={0}
      />
    </ReactFlowProvider>
  )
}

function worktreeView(node: WorktreeCanvasNode): ReactElement {
  return (
    <ReactFlowProvider>
      <WorktreeNode
        id={node.id}
        data={node.data}
        type="worktreeNode"
        dragging={false}
        zIndex={0}
        selectable
        deletable={false}
        selected={false}
        draggable
        isConnectable={false}
        positionAbsoluteX={0}
        positionAbsoluteY={0}
      />
    </ReactFlowProvider>
  )
}

beforeEach(() => {
  stubWorktreeApi()
})

describe('a new worktree with its first chat', () => {
  for (const provider of ['claude', 'codex'] as const) {
    test(`launches one ${provider} session in the worktree directory and gives it the caret`, async () => {
      const agent = createMockAgentApi()
      window.agentApi = agent.api

      const nodes = await createWithFirstChat(provider)

      expect(nodes.filter(isWorktreeCanvasNode)).toHaveLength(1)
      const chats = nodes.filter(isTerminalCanvasNode)
      expect(chats).toHaveLength(1)
      expect(chats[0].data).toMatchObject({ kind: provider, worktreeId: 'worktree-1', workingDirectory: WORKTREE_PATH })

      render(chatView(chats[0]))

      await waitFor(() => expect(agent.api.create).toHaveBeenCalledTimes(1))
      expect(agent.api.create).toHaveBeenCalledWith(expect.objectContaining({ provider, cwd: WORKTREE_PATH }))
      // An ordinary chat: nothing is sent on the user's behalf, and the composer is theirs.
      expect(agent.api.prompt).not.toHaveBeenCalled()
      expect(agent.api.promptWhenIdle).not.toHaveBeenCalled()
      expect(screen.getByPlaceholderText('Message the agent...')).toHaveFocus()
    })
  }

  test('a chat that fails to start leaves the worktree with its own start-chat actions', async () => {
    const agent = createMockAgentApi({
      create: vi.fn(async () => ({ ok: false, status: 'error' as const, message: 'claude-agent-acp is not installed' }))
    })
    window.agentApi = agent.api
    const callbacks = worktreeCallbacks()

    const nodes = await createWithFirstChat('claude', callbacks)
    render(chatView(nodes.filter(isTerminalCanvasNode)[0]))
    await waitFor(() => expect(screen.getByText(/session ended/)).toBeVisible())

    render(worktreeView(nodes.filter(isWorktreeCanvasNode)[0]))
    fireEvent.click(screen.getByTitle('New Claude session in this worktree'))

    // The retry opens another chat in the same worktree through the canvas - git is not asked again.
    expect(callbacks.onCreateNodeInWorktree).toHaveBeenCalledWith('worktree-1', 'claude')
    expect(window.worktreeApi.create).toHaveBeenCalledTimes(1)
  })
})

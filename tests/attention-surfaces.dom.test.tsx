import { ReactFlowProvider } from '@xyflow/react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import ChatNode from '../src/renderer/src/ChatNode'
import {
  isTerminalCanvasNode,
  restoreCanvasWorkspace,
  type NodeAttentionAction,
  type TerminalCanvasNode,
  type TerminalNodeCallbacks,
  type WorktreeNodeCallbacks
} from '../src/renderer/src/canvas-workspace'
import {
  applyAttentionAction,
  attentionTextKey,
  countUnreadAttention,
  READ_ON_VIEW_KINDS,
  unreadAttentionByNode,
  type AttentionState
} from '../src/shared/attention'
import type { WorkspaceState } from '../src/shared/terminal'
import { createMockAgentApi, type MockAgentApi } from './dom/agent-api-mock'

const NODE_ID = 'claude-node'

/**
 * The workspace's reducer, driven by whatever the node reports. Keeping the real reducer in the
 * loop is the point: these tests are about the wiring producing signals the durable model can
 * actually deduplicate and clear, not about a spy being called.
 */
function createAttentionWorkspace(): {
  state(): AttentionState
  onAttention: (action: NodeAttentionAction) => void
  clock: { now: number }
} {
  const clock = { now: 1_700_000_000_000 }
  let state: AttentionState = []
  return {
    clock,
    state: () => state,
    onAttention: (action) => {
      clock.now += 10_000
      const at = clock.now
      state = applyAttentionAction(state, action, at)
    }
  }
}

function chatNode(callbacks: TerminalNodeCallbacks & WorktreeNodeCallbacks): TerminalCanvasNode {
  const state: WorkspaceState = {
    version: 3,
    projects: [{ id: 'project-1', name: 'ADE', path: '/project', color: '#71a9ff' }],
    activeProjectId: 'project-1',
    sidebarCollapsed: false,
    nodes: [{
      id: NODE_ID,
      kind: 'claude',
      label: 'Claude 1',
      projectId: 'project-1',
      position: { x: 0, y: 0 },
      width: 640,
      height: 480,
      conversationId: 'claude-conversation'
    }],
    worktrees: []
  }
  const restored = restoreCanvasWorkspace(state, callbacks)
  const node = restored.nodes.find(isTerminalCanvasNode)
  if (!node) throw new Error('Expected the chat node to restore.')
  return node
}

function renderChat(node: TerminalCanvasNode, { selected, unread }: { selected: boolean; unread: number }) {
  return render(
    <ReactFlowProvider>
      <ChatNode
        id={node.id}
        data={{ ...node.data, unread }}
        type="terminalNode"
        dragging={false}
        zIndex={0}
        selectable
        deletable
        selected={selected}
        draggable
        width={640}
        height={480}
        isConnectable={false}
        positionAbsoluteX={0}
        positionAbsoluteY={0}
      />
    </ReactFlowProvider>
  )
}

let mock: MockAgentApi

function baseCallbacks(onAttention: (action: NodeAttentionAction) => void): TerminalNodeCallbacks & WorktreeNodeCallbacks {
  return {
    onStatusChange: vi.fn(),
    onAttention,
    onConversationId: vi.fn(),
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
}

beforeEach(() => {
  mock = createMockAgentApi()
  window.agentApi = mock.api
})

/** Lets the session's own create() promise settle so it cannot overwrite an emitted status. */
async function settle(): Promise<void> {
  await act(async () => { await Promise.resolve() })
}

async function finishTurn(answer: string): Promise<void> {
  await act(async () => {
    mock.emit(NODE_ID, { type: 'status', status: 'working' })
  })
  await act(async () => {
    mock.emit(NODE_ID, { type: 'message', role: 'assistant', messageId: 'assistant-current', text: answer })
    mock.emit(NODE_ID, { type: 'turn_complete', stopReason: 'end_turn' })
    mock.emit(NODE_ID, { type: 'status', status: 'idle' })
  })
}

describe('chat node attention wiring', () => {
  test('a turn that finishes off-screen becomes one unread result, and replaying it adds nothing', async () => {
    const workspace = createAttentionWorkspace()
    const node = chatNode(baseCallbacks(workspace.onAttention))
    const first = renderChat(node, { selected: false, unread: 0 })
    await settle()

    await finishTurn('Here is the migration plan.')
    await waitFor(() => expect(countUnreadAttention(workspace.state())).toBe(1))
    expect(workspace.state()[0].kind).toBe('result')
    expect(workspace.state()[0].sourceId).toBe('claude-conversation')

    // A restart replays the same transcript through the same handler; the key is the answer, so
    // it lands on the record that already exists rather than raising a second one.
    first.unmount()
    renderChat(node, { selected: false, unread: 1 })
    await settle()
    await finishTurn('Here is the migration plan.')

    await waitFor(() => expect(workspace.state().length).toBe(1))
    expect(countUnreadAttention(workspace.state())).toBe(1)
  })

  test('a replayed turn does not resurrect a result the user already read', async () => {
    const workspace = createAttentionWorkspace()
    const node = chatNode(baseCallbacks(workspace.onAttention))
    const first = renderChat(node, { selected: false, unread: 0 })
    await settle()

    await finishTurn('All tests pass.')
    await waitFor(() => expect(countUnreadAttention(workspace.state())).toBe(1))
    workspace.onAttention({ type: 'read', nodeId: NODE_ID })
    expect(countUnreadAttention(workspace.state())).toBe(0)

    first.unmount()
    renderChat(node, { selected: false, unread: 0 })
    await settle()
    await finishTurn('All tests pass.')

    await waitFor(() => expect(workspace.state().length).toBe(1))
    expect(countUnreadAttention(workspace.state())).toBe(0)
  })

  test('keys a finished-turn notification from the final answer rather than progress narration', async () => {
    const workspace = createAttentionWorkspace()
    const node = chatNode(baseCallbacks(workspace.onAttention))
    renderChat(node, { selected: false, unread: 0 })
    await settle()

    await act(async () => {
      mock.emit(NODE_ID, { type: 'status', status: 'working' })
    })
    await act(async () => {
      mock.emit(NODE_ID, {
        type: 'message', role: 'assistant', presentation: 'final', messageId: 'answer', text: 'Created 4 topics.'
      })
      mock.emit(NODE_ID, {
        type: 'message', role: 'assistant', presentation: 'progress', messageId: 'progress', text: 'Archiving notes.'
      })
      mock.emit(NODE_ID, { type: 'turn_complete', stopReason: 'end_turn' })
      mock.emit(NODE_ID, { type: 'status', status: 'idle' })
    })

    await waitFor(() => expect(countUnreadAttention(workspace.state())).toBe(1))
    expect(workspace.state()[0].key).toBe(attentionTextKey('answer:Created 4 topics.'))
  })

  test('a progress-only turn does not raise a final-result notification', async () => {
    const workspace = createAttentionWorkspace()
    const node = chatNode(baseCallbacks(workspace.onAttention))
    renderChat(node, { selected: false, unread: 0 })
    await settle()

    await act(async () => {
      mock.emit(NODE_ID, { type: 'status', status: 'working' })
    })
    await act(async () => {
      mock.emit(NODE_ID, {
        type: 'message', role: 'assistant', presentation: 'progress', messageId: 'progress', text: 'Still working.'
      })
      mock.emit(NODE_ID, { type: 'turn_complete', stopReason: 'end_turn' })
      mock.emit(NODE_ID, { type: 'status', status: 'idle' })
    })

    expect(workspace.state()).toHaveLength(0)
  })

  test('a later progress-only turn does not reuse an earlier final answer for result attention', async () => {
    const workspace = createAttentionWorkspace()
    const reportAttention = vi.fn(workspace.onAttention)
    const node = chatNode(baseCallbacks(reportAttention))
    renderChat(node, { selected: false, unread: 0 })
    await settle()

    await finishTurn('The first turn finished.')
    await waitFor(() => expect(countUnreadAttention(workspace.state())).toBe(1))
    reportAttention.mockClear()

    await act(async () => {
      mock.emit(NODE_ID, { type: 'status', status: 'working' })
    })
    await act(async () => {
      mock.emit(NODE_ID, {
        type: 'message', role: 'assistant', presentation: 'progress', messageId: 'later-progress', text: 'Still working.'
      })
      mock.emit(NODE_ID, { type: 'turn_complete', stopReason: 'end_turn' })
      mock.emit(NODE_ID, { type: 'status', status: 'idle' })
    })

    expect(reportAttention).not.toHaveBeenCalledWith(expect.objectContaining({
      signal: expect.objectContaining({ kind: 'result' })
    }))
  })

  test('an approval is one record keyed by its request, retired when it is answered', async () => {
    const workspace = createAttentionWorkspace()
    const node = chatNode(baseCallbacks(workspace.onAttention))
    renderChat(node, { selected: false, unread: 0 })
    await settle()

    const approval = {
      type: 'approval' as const,
      approvalId: 'perm-7',
      title: 'Run command: npm test',
      options: [{ id: 'allow', label: 'Allow Once', kind: 'allow_once' as const }]
    }
    await act(async () => {
      mock.emit(NODE_ID, approval)
      mock.emit(NODE_ID, approval)
    })

    await waitFor(() => expect(countUnreadAttention(workspace.state())).toBe(1))
    expect(workspace.state()[0].kind).toBe('approval')
    expect(workspace.state()[0].key).toBe('perm-7')

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Allow Once' }))
    })

    await waitFor(() => expect(workspace.state()).toHaveLength(0))
  })

  test('a sign-in request is raised while it holds and retired once the session gets past it', async () => {
    const workspace = createAttentionWorkspace()
    const node = chatNode(baseCallbacks(workspace.onAttention))
    renderChat(node, { selected: false, unread: 0 })
    await settle()

    await act(async () => {
      mock.emit(NODE_ID, { type: 'status', status: 'auth_required' })
      mock.emit(NODE_ID, { type: 'auth', methods: [{ id: 'oauth', name: 'Sign in' }] })
    })
    await waitFor(() => expect(unreadAttentionByNode(workspace.state())).toEqual({ [NODE_ID]: 1 }))
    expect(workspace.state()[0].kind).toBe('auth')

    await act(async () => {
      mock.emit(NODE_ID, { type: 'status', status: 'idle' })
    })
    await waitFor(() => expect(workspace.state()).toHaveLength(0))
  })

  test('a failure is keyed by its text, so the same error reported twice is one record', async () => {
    const workspace = createAttentionWorkspace()
    const node = chatNode(baseCallbacks(workspace.onAttention))
    renderChat(node, { selected: false, unread: 0 })
    await settle()

    await act(async () => {
      mock.emit(NODE_ID, { type: 'error', message: 'The adapter closed the connection.' })
    })
    await waitFor(() => expect(countUnreadAttention(workspace.state())).toBe(1))

    await act(async () => {
      mock.emit(NODE_ID, { type: 'error', message: 'The adapter closed the connection.' })
    })
    await act(async () => {
      mock.emit(NODE_ID, { type: 'error', message: 'Model overloaded.' })
    })

    await waitFor(() => expect(countUnreadAttention(workspace.state())).toBe(2))
    expect(workspace.state().map((item) => item.kind)).toEqual(['failure', 'failure'])
  })

  test('opening the node clears its records and the toggle puts the last batch back', async () => {
    const workspace = createAttentionWorkspace()
    workspace.onAttention({
      type: 'raise',
      signal: { nodeId: NODE_ID, kind: 'result', key: 'turn-a', summary: 'Claude 1 finished a turn' }
    })
    const node = chatNode(baseCallbacks(workspace.onAttention))

    const view = renderChat(node, { selected: true, unread: 1 })
    await waitFor(() => expect(countUnreadAttention(workspace.state())).toBe(0))

    view.rerender(
      <ReactFlowProvider>
        <ChatNode
          id={node.id}
          data={{ ...node.data, unread: 0 }}
          type="terminalNode"
          dragging={false}
          zIndex={0}
          selectable
          deletable
          selected
          draggable
          width={640}
          height={480}
          isConnectable={false}
          positionAbsoluteX={0}
          positionAbsoluteY={0}
        />
      </ReactFlowProvider>
    )

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Mark unread' }))
    })

    expect(countUnreadAttention(workspace.state())).toBe(1)
    expect(workspace.state()[0].key).toBe('turn-a')
  })
})

describe('what reading a node does not clear', () => {
  test('a pending approval survives the user looking straight at it', async () => {
    const workspace = createAttentionWorkspace()
    const node = chatNode(baseCallbacks(workspace.onAttention))
    renderChat(node, { selected: true, unread: 0 })
    await settle()

    await act(async () => {
      mock.emit(NODE_ID, {
        type: 'approval',
        approvalId: 'perm-7',
        title: 'Run command: npm test',
        options: [{ id: 'allow', label: 'Allow Once', kind: 'allow_once' }]
      })
      mock.emit(NODE_ID, { type: 'message', role: 'assistant', messageId: 'assistant-current', text: 'Working on it.' })
    })

    // Selecting the node reports a read, but glancing at a blocked turn is not unblocking it:
    // only answering the request retires the record.
    workspace.onAttention({ type: 'read', nodeId: NODE_ID, kinds: READ_ON_VIEW_KINDS })

    expect(countUnreadAttention(workspace.state())).toBe(1)
    expect(workspace.state()[0].kind).toBe('approval')
  })

  test('an unanswered sign-in request is still unread after a restart replays it', async () => {
    const workspace = createAttentionWorkspace()
    const node = chatNode(baseCallbacks(workspace.onAttention))
    const first = renderChat(node, { selected: false, unread: 0 })
    await settle()

    await act(async () => {
      mock.emit(NODE_ID, { type: 'status', status: 'auth_required' })
    })
    expect(countUnreadAttention(workspace.state())).toBe(1)

    workspace.onAttention({ type: 'read', nodeId: NODE_ID, kinds: READ_ON_VIEW_KINDS })
    first.unmount()

    renderChat(node, { selected: false, unread: 1 })
    await settle()
    await act(async () => {
      mock.emit(NODE_ID, { type: 'status', status: 'auth_required' })
    })

    await waitFor(() => expect(countUnreadAttention(workspace.state())).toBe(1))
    expect(workspace.state()[0].kind).toBe('auth')
  })
})

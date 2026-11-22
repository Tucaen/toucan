import { fireEvent, screen, waitFor } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import type { ConversationSummary } from '../src/shared/conversation'
import type { WorkspaceTerminalNode } from '../src/shared/workspace'
import { createMockAgentApi } from './dom/agent-api-mock'
import { DEFAULT_PROJECT, renderApp, savedWorkspace } from './dom/app-harness'

vi.mock('@xterm/xterm', async () => (await import('./dom/xterm-mock')).xtermModule())
vi.mock('@xterm/addon-fit', async () => (await import('./dom/xterm-mock')).fitAddonModule())

// Tucaen/toucan#1: an orchestrator conversation must come back as an orchestrator - its badge, its
// role on `agent:create` (which is what mints the token and the CLI environment) and its controls -
// whether Toucan restarts with the node on the canvas or the conversation is reopened from History.

const ORCHESTRATOR_CONVERSATION = 'orchestrator-conversation'

function savedOrchestrator(overrides: Partial<WorkspaceTerminalNode> = {}): WorkspaceTerminalNode {
  return {
    id: 'orchestrator-node',
    kind: 'claude',
    label: 'Orchestrator 1',
    projectId: DEFAULT_PROJECT.id,
    position: { x: 0, y: 0 },
    width: 750,
    height: 660,
    conversationId: ORCHESTRATOR_CONVERSATION,
    focusMode: true,
    role: 'orchestrator',
    ...overrides
  }
}

function historyEntry(overrides: Partial<ConversationSummary> = {}): ConversationSummary {
  return {
    id: ORCHESTRATOR_CONVERSATION,
    provider: 'claude',
    path: 'C:\\transcripts\\orchestrator-conversation.jsonl',
    title: 'Ship the release pipeline',
    updatedAt: new Date().toISOString(),
    messageCount: 4,
    cwd: DEFAULT_PROJECT.path,
    ...overrides
  }
}

function orchestratorBadge(): Element | null {
  return document.querySelector('.chat-node-header .node-orchestrator-badge')
}

test.each(['claude', 'codex'] as const)(
  'a restart restores a saved %s orchestrator as an orchestrator',
  async (kind) => {
    const agent = createMockAgentApi()
    const orchestrationState = vi.fn(async () => null)
    await renderApp({
      state: savedWorkspace({ nodes: [savedOrchestrator({ kind })] }),
      apis: {
        agentApi: agent.api as unknown as Record<string, unknown>,
        orchestratorApi: { orchestrationState }
      }
    })

    await waitFor(() =>
      expect(vi.mocked(agent.api.create)).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'orchestrator-node',
          provider: kind,
          role: 'orchestrator',
          sessionId: ORCHESTRATOR_CONVERSATION
        })
      )
    )
    expect(orchestratorBadge()).toHaveTextContent('Orchestrator')
    await waitFor(() =>
      expect(orchestrationState).toHaveBeenCalledWith({
        provider: kind,
        conversationId: ORCHESTRATOR_CONVERSATION,
        nodeId: 'orchestrator-node'
      })
    )
  }
)

test.each(['claude', 'codex'] as const)(
  'reopening a closed %s orchestrator from History restores it as an orchestrator',
  async (provider) => {
    const agent = createMockAgentApi()
    const harness = await renderApp({
      apis: {
        agentApi: agent.api as unknown as Record<string, unknown>,
        conversationApi: {
          list: vi.fn(async () => ({
            entries: [historyEntry({ provider, role: 'orchestrator' })],
            total: 1,
            hasMore: false
          })),
          exists: vi.fn(async () => true)
        }
      }
    })

    fireEvent.contextMenu(document.querySelector('.react-flow__pane')!, { clientX: 400, clientY: 300 })
    fireEvent.click(screen.getByRole('menuitem', { name: /^History/ }))
    fireEvent.click(await screen.findByText('Ship the release pipeline'))

    await waitFor(() =>
      expect(vi.mocked(agent.api.create)).toHaveBeenCalledWith(
        expect.objectContaining({
          provider,
          role: 'orchestrator',
          sessionId: ORCHESTRATOR_CONVERSATION
        })
      )
    )
    expect(orchestratorBadge()).toHaveTextContent('Orchestrator')
    await waitFor(() =>
      expect(harness.saved.at(-1)?.nodes).toEqual([
        expect.objectContaining({ kind: provider, role: 'orchestrator', conversationId: ORCHESTRATOR_CONVERSATION })
      ])
    )
  }
)

test('reopening an ordinary conversation from History still opens a plain chat', async () => {
  const agent = createMockAgentApi()
  await renderApp({
    apis: {
      agentApi: agent.api as unknown as Record<string, unknown>,
      conversationApi: {
        list: vi.fn(async () => ({ entries: [historyEntry()], total: 1, hasMore: false })),
        exists: vi.fn(async () => true)
      }
    }
  })

  fireEvent.contextMenu(document.querySelector('.react-flow__pane')!, { clientX: 400, clientY: 300 })
  fireEvent.click(screen.getByRole('menuitem', { name: /^History/ }))
  fireEvent.click(await screen.findByText('Ship the release pipeline'))

  await waitFor(() =>
    expect(vi.mocked(agent.api.create)).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: ORCHESTRATOR_CONVERSATION })
    )
  )
  expect(vi.mocked(agent.api.create).mock.calls[0][0]).not.toHaveProperty('role')
  expect(orchestratorBadge()).toBeNull()
})

test('an orchestrator reopened from History takes back the ticket sessions still on the canvas', async () => {
  const agent = createMockAgentApi()
  const ticket: WorkspaceTerminalNode = {
    id: 'ticket-node',
    kind: 'claude',
    label: '#1 Ship it',
    titleSource: 'manual',
    projectId: DEFAULT_PROJECT.id,
    position: { x: 900, y: 0 },
    width: 750,
    height: 660,
    conversationId: 'ticket-conversation',
    focusMode: false,
    orchestratedBy: { nodeId: 'closed-orchestrator', conversationId: ORCHESTRATOR_CONVERSATION, provider: 'claude' }
  }
  const harness = await renderApp({
    state: savedWorkspace({ nodes: [ticket] }),
    apis: {
      agentApi: agent.api as unknown as Record<string, unknown>,
      conversationApi: {
        list: vi.fn(async () => ({
          entries: [historyEntry({ role: 'orchestrator' })],
          total: 1,
          hasMore: false
        })),
        exists: vi.fn(async () => true)
      }
    }
  })

  fireEvent.contextMenu(document.querySelector('.react-flow__pane')!, { clientX: 400, clientY: 300 })
  fireEvent.click(screen.getByRole('menuitem', { name: /^History/ }))
  fireEvent.click(await screen.findByText('Ship the release pipeline'))

  await waitFor(() => {
    const nodes = harness.saved.at(-1)?.nodes ?? []
    const reopened = nodes.find((node) => node.conversationId === ORCHESTRATOR_CONVERSATION)
    expect(reopened?.role).toBe('orchestrator')
    expect(nodes.find((node) => node.id === 'ticket-node')?.orchestratedBy).toEqual({
      nodeId: reopened?.id,
      conversationId: ORCHESTRATOR_CONVERSATION,
      provider: 'claude'
    })
  })
})

import { act, screen, waitFor } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import type { AgentApi, AgentCreateRequest, AgentProvider } from '../src/shared/agent'
import type { TicketSessionCanvasRequest, TicketSessionCanvasResult } from '../src/shared/ticket-session-spawn'
import type { WorkspaceState } from '../src/shared/workspace'
import type { TicketCleanupRequest, TicketCleanupResult } from '../src/shared/orchestration-cleanup'
import { createMockAgentApi } from './dom/agent-api-mock'
import { DEFAULT_PROJECT as project, renderApp, savedWorkspace } from './dom/app-harness'

/**
 * The canvas half of an orchestrator's `spawn` (#34): main has created, guarded and set up the
 * worktree, and asks the renderer for the ticket session. What crossed the seam is asserted - the
 * create request the chat launched with and the verdict main was handed - rather than anything
 * re-derived here.
 */

const orchestratorLink = { nodeId: 'orchestrator-1', conversationId: 'conversation-orchestrator' }

const workspace: WorkspaceState = savedWorkspace({
  nodes: [
    {
      id: 'orchestrator-1',
      kind: 'claude',
      label: 'Orchestrator 1',
      projectId: project.id,
      position: { x: 0, y: 0 },
      width: 520,
      height: 340,
      conversationId: 'conversation-orchestrator',
      role: 'orchestrator'
    }
  ]
})

const request: TicketSessionCanvasRequest = {
  provider: 'claude',
  projectId: project.id,
  worktree: { path: 'D:\\Development\\Toucan-ticket-34', branch: 'ticket/34', baseRef: 'main' },
  label: '#34 Spawn',
  modelId: 'claude-opus-5-5',
  effortId: 'high',
  permissionMode: 'acceptEdits',
  orchestratedBy: orchestratorLink,
  prompt: '/implement #34 Spawn\n\n## Ticket contract'
}

async function render(agentOverrides: Partial<AgentApi> = {}, provider: AgentProvider = 'claude') {
  let cleanupTicket: ((requestId: string, request: TicketCleanupRequest) => void) | null = null
  const cleanupResults: TicketCleanupResult[] = []
  let requestTicketSession: ((requestId: string, request: TicketSessionCanvasRequest) => void) | null = null
  const results: { requestId: string; result: TicketSessionCanvasResult }[] = []
  const agent = createMockAgentApi({
    create: vi.fn(async ({ id }) => ({ ok: true, status: 'ready' as const, sessionId: `conversation-${id}` })),
    ...agentOverrides
  })
  const harness = await renderApp({
    state: { ...workspace, nodes: workspace.nodes.map((node) => ({ ...node, kind: provider })) },
    apis: {
      agentApi: agent.api as unknown as Record<string, unknown>,
      orchestratorApi: {
        onCleanupTicket: (callback: typeof cleanupTicket) => {
          cleanupTicket = callback
          return () => {
            cleanupTicket = null
          }
        },
        completeCleanupTicket: (_id: string, result: TicketCleanupResult) => cleanupResults.push(result),
        onStartTicketSession: (callback: typeof requestTicketSession) => {
          requestTicketSession = callback
          return () => {
            requestTicketSession = null
          }
        },
        completeTicketSession: (requestId: string, result: TicketSessionCanvasResult) =>
          results.push({ requestId, result })
      }
    }
  })
  await waitFor(() => expect(requestTicketSession).not.toBeNull())
  return {
    harness,
    agent,
    results,
    cleanupResults,
    cleanup: (body: TicketCleanupRequest) => cleanupTicket!('cleanup', body),
    start: (id: string, body = request) => requestTicketSession!(id, body)
  }
}

const createRequests = (agent: ReturnType<typeof createMockAgentApi>): AgentCreateRequest[] =>
  vi.mocked(agent.api.create).mock.calls.map(([created]) => created)

describe('a ticket session requested by an orchestrator', () => {
  test('cleanup suspends its settled chat before removing the worktree canvas', async () => {
    const { start, results, cleanup, cleanupResults, agent } = await render()
    start('ticket-1')
    await waitFor(() => expect(results).toHaveLength(1))
    const session = results[0].result as { nodeId: string; conversationId: string }
    await waitFor(() => expect(vi.mocked(agent.api.prompt).mock.calls.length).toBeGreaterThan(0))
    await act(async () => {
      agent.emit(session.nodeId, { type: 'turn_complete' })
      agent.emit(session.nodeId, { type: 'status', status: 'ready' })
    })
    const body: TicketCleanupRequest = {
      projectPath: project.path,
      session: { ...session, worktreePath: request.worktree.path, branch: request.worktree.branch },
      phase: 'close'
    }
    await waitFor(() => {
      cleanup(body)
      expect(cleanupResults.at(-1)).toEqual({ ok: true })
    })
    await waitFor(() => expect(agent.api.kill).toHaveBeenCalledWith(session.nodeId))
    expect(screen.queryAllByText('#34 Spawn').length).toBeGreaterThan(0)
    cleanup({ ...body, phase: 'remove' })
    await waitFor(() => expect(screen.queryAllByText('ticket/34')).toHaveLength(0))
    expect(screen.queryAllByText('#34 Spawn')).toHaveLength(0)
    expect(cleanupResults.at(-1)).toEqual({ ok: true })
    expect(screen.getAllByText('Orchestrator 1').length).toBeGreaterThan(0)
  })

  test('opens a Claude chat in its worktree on the model, effort and mode main named', async () => {
    const { agent, results, start } = await render()
    start('ticket-1')

    await waitFor(() => expect(results).toHaveLength(1))
    const answer = results[0]
    expect(answer.requestId).toBe('ticket-1')
    expect(answer.result.ok).toBe(true)
    const { nodeId, conversationId } = answer.result as { nodeId: string; conversationId: string }

    const created = createRequests(agent).find((entry) => entry.id === nodeId)!
    expect(created.provider).toBe('claude')
    expect(created.cwd).toBe('D:\\Development\\Toucan-ticket-34')
    expect(created.modelId).toBe('claude-opus-5-5')
    expect(created.effortId).toBe('high')
    expect(created.permissionMode).toBe('acceptEdits')
    // A ticket session is never an orchestrator, so it is never minted a token: no nesting.
    expect(created.role).toBeUndefined()
    // The id main records is the conversation the session opened under.
    expect(created.sessionId ?? conversationId).toBe(conversationId)

    // Prompted with the implementation skill, the ticket and the contract.
    await waitFor(() =>
      expect(JSON.stringify(vi.mocked(agent.api.prompt).mock.calls)).toContain('/implement #34 Spawn')
    )
    // Titled by its ticket, on the worktree's canvas.
    expect((await screen.findAllByText('#34 Spawn')).length).toBeGreaterThan(0)
    expect(screen.getAllByText('ticket/34').length).toBeGreaterThan(0)
  })

  test('is saved with its manual title, its worktree and the orchestrated-by link', async () => {
    const { harness, results, start } = await render()
    start('ticket-1')
    await waitFor(() => expect(results).toHaveLength(1))
    const { nodeId } = results[0].result as { nodeId: string }

    await waitFor(() => {
      const latest = harness.saved[harness.saved.length - 1]
      const ticket = latest?.nodes.find((node) => node.id === nodeId)
      expect(ticket?.orchestratedBy).toEqual(orchestratorLink)
    })
    const latest = harness.saved[harness.saved.length - 1]
    const ticket = latest.nodes.find((node) => node.id === nodeId)!
    expect(ticket.label).toBe('#34 Spawn')
    expect(ticket.titleSource).toBe('manual')
    const worktree = latest.worktrees.find((entry) => entry.id === ticket.worktreeId)
    expect(worktree?.path).toBe('D:\\Development\\Toucan-ticket-34')
    expect(worktree?.branch).toBe('ticket/34')
  })

  test('opens exactly one Codex ticket chat and persists its provider and provenance', async () => {
    const { harness, agent, results, start } = await render({}, 'codex')
    const codexRequest: TicketSessionCanvasRequest = {
      ...request,
      provider: 'codex',
      orchestratedBy: { ...orchestratorLink, provider: 'codex' },
      modelId: 'gpt-6',
      effortId: 'xhigh',
      permissionMode: 'auto'
    }
    start('codex-ticket', codexRequest)
    await waitFor(() => expect(results).toHaveLength(1))
    const result = results[0].result
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.message)
    const launches = createRequests(agent).filter((entry) => entry.id === result.nodeId)
    expect(launches).toHaveLength(1)
    expect(launches[0]).toMatchObject({
      provider: 'codex',
      modelId: 'gpt-6',
      effortId: 'xhigh',
      permissionMode: 'auto',
      cwd: request.worktree.path
    })
    expect(launches[0].role).toBeUndefined()
    await waitFor(() => expect(agent.api.prompt).toHaveBeenCalledWith(result.nodeId, request.prompt))
    await waitFor(() => {
      const ticket = harness.saved.at(-1)?.nodes.find((node) => node.id === result.nodeId)
      expect(ticket?.kind).toBe('codex')
      expect(ticket?.orchestratedBy).toEqual(codexRequest.orchestratedBy)
      expect(ticket?.worktreeId).toBeTruthy()
    })
  })

  test('a session that cannot start is reported as a failure', async () => {
    const { results, start } = await render({
      create: vi.fn(async () => ({ ok: false as const, status: 'error' as const, message: 'no adapter' }))
    })
    start('ticket-1')
    await waitFor(() => expect(results).toHaveLength(1))
    expect(results[0].result).toEqual({ ok: false, message: 'The ticket session could not be started on the desktop.' })
  })

  test('a project the canvas no longer has is refused', async () => {
    const { results, start } = await render()
    start('ticket-1', { ...request, projectId: 'closed-project' })
    await waitFor(() => expect(results).toHaveLength(1))
    expect(results[0].result).toEqual({ ok: false, message: 'That project is no longer open on the desktop.' })
  })
})

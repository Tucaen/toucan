import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import type { AgentApi, AgentCreateRequest, AgentProvider } from '../src/shared/agent'
import type {
  TicketSessionCanvasAnswer,
  TicketSessionCanvasRequest,
  TicketSessionProgress
} from '../src/shared/ticket-session-spawn'
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
  orchestratedBy: orchestratorLink,
  prompt: '/implement #34 Spawn\n\n## Ticket contract'
}

async function render(agentOverrides: Partial<AgentApi> = {}, provider: AgentProvider = 'claude') {
  let cleanupTicket: ((requestId: string, request: TicketCleanupRequest) => void) | null = null
  const cleanupResults: TicketCleanupResult[] = []
  let requestTicketSession: ((requestId: string, request: TicketSessionCanvasRequest) => void) | null = null
  let cancelTicketSession: ((nodeId: string) => void) | null = null
  const progress: { requestId: string; progress: TicketSessionProgress }[] = []
  const results: { requestId: string; result: TicketSessionCanvasAnswer }[] = []
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
        completeTicketSession: (requestId: string, result: TicketSessionCanvasAnswer) =>
          results.push({ requestId, result }),
        progressTicketSession: (requestId: string, reported: TicketSessionProgress) =>
          progress.push({ requestId, progress: reported }),
        onCancelTicketSession: (callback: typeof cancelTicketSession) => {
          cancelTicketSession = callback
          return () => {
            cancelTicketSession = null
          }
        }
      }
    }
  })
  await waitFor(() => expect(requestTicketSession).not.toBeNull())
  return {
    harness,
    agent,
    results,
    progress,
    cleanupResults,
    cleanup: (body: TicketCleanupRequest) => cleanupTicket!('cleanup', body),
    start: (id: string, body = request) => requestTicketSession!(id, body),
    cancel: (nodeId: string) => cancelTicketSession!(nodeId)
  }
}

const createRequests = (agent: ReturnType<typeof createMockAgentApi>): AgentCreateRequest[] =>
  vi.mocked(agent.api.create).mock.calls.map(([created]) => created)

/** The one worktree frame on the main canvas: the ticket's, in these tests. */
function frame(): HTMLElement {
  const element = document.querySelector<HTMLElement>('.react-flow__node-worktreeNode')
  if (!element) throw new Error('the ticket worktree is not rendered')
  return element
}

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
      phase: 'retire'
    }
    await waitFor(() => {
      cleanup(body)
      expect(cleanupResults.at(-1)).toEqual({ ok: true })
    })
    await waitFor(() => expect(agent.api.kill).toHaveBeenCalledWith(session.nodeId))
    expect(screen.queryAllByText('#34 Spawn').length).toBeGreaterThan(0)
    cleanup({ ...body, phase: 'prepare' })
    expect(cleanupResults.at(-1)).toEqual({ ok: true })
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
    // No mode is requested: main starts the session in the provider's default (Claude's Auto).
    expect(created.permissionMode).toBeUndefined()
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

  test('its worktree is kept off the canvas, running, and the sidebar eye shows and hides it', async () => {
    const { harness, agent, results, start } = await render()
    start('ticket-1')
    await waitFor(() => expect(results).toHaveLength(1))
    const { nodeId } = results[0].result as { nodeId: string }

    // The session runs: created, prompted with its ticket - from a worktree the canvas does not show.
    await waitFor(() =>
      expect(JSON.stringify(vi.mocked(agent.api.prompt).mock.calls)).toContain('/implement #34 Spawn')
    )
    // Concealed, not removed: the frame and its chat stay mounted, so the session is never killed.
    await waitFor(() => expect(frame()).toHaveClass('worktree-concealed'))
    // Inert: React Flow sets pointer-events inline on every node, so this is what keeps the pointer,
    // the caret and the accessibility tree out of the hidden frame and the chats on it.
    expect(frame()).toHaveAttribute('inert')
    expect(frame()).toHaveAttribute('aria-hidden', 'true')
    expect(frame().querySelector(`.react-flow__node[data-id="${nodeId}"]`)).not.toBeNull()
    await waitFor(() => {
      const saved = harness.saved.at(-1)?.worktrees.find((entry) => entry.branch === 'ticket/34')
      expect(saved?.concealed).toBe(true)
    })

    // The eye shows it, pressed while shown...
    fireEvent.click(screen.getByRole('button', { name: 'Show ticket/34 on the canvas' }))
    await waitFor(() => expect(frame()).not.toHaveClass('worktree-concealed'))
    expect(frame()).not.toHaveAttribute('inert')
    expect(screen.getByRole('button', { name: 'Hide ticket/34 from the canvas' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    await waitFor(() =>
      expect(harness.saved.at(-1)?.worktrees.find((entry) => entry.branch === 'ticket/34')?.concealed).toBeUndefined()
    )

    // ...and hides it again.
    fireEvent.click(screen.getByRole('button', { name: 'Hide ticket/34 from the canvas' }))
    await waitFor(() => expect(frame()).toHaveClass('worktree-concealed'))
    expect(screen.getByRole('button', { name: 'Show ticket/34 on the canvas' })).toHaveAttribute(
      'aria-pressed',
      'false'
    )
    // Through all of it the session was never stopped and never started again.
    expect(agent.api.kill).not.toHaveBeenCalledWith(nodeId)
    expect(createRequests(agent).filter((entry) => entry.id === nodeId)).toHaveLength(1)
  })

  test('going to a concealed ticket chat from the sidebar shows its worktree', async () => {
    const { results, start } = await render()
    start('ticket-1')
    await waitFor(() => expect(results).toHaveLength(1))
    await waitFor(() => expect(frame()).toHaveClass('worktree-concealed'))

    const row = screen
      .getAllByText('#34 Spawn')
      .map((element) => element.closest('.project-node-row'))
      .find((element): element is HTMLElement => element !== null)!
    fireEvent.click(row)
    await waitFor(() => expect(frame()).not.toHaveClass('worktree-concealed'))
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
      effortId: 'xhigh'
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
      cwd: request.worktree.path
    })
    expect(launches[0].permissionMode).toBeUndefined()
    expect(launches[0].role).toBeUndefined()
    await waitFor(() => expect(agent.api.prompt).toHaveBeenCalledWith(result.nodeId, request.prompt))
    await waitFor(() => {
      const ticket = harness.saved.at(-1)?.nodes.find((node) => node.id === result.nodeId)
      expect(ticket?.kind).toBe('codex')
      expect(ticket?.orchestratedBy).toEqual(codexRequest.orchestratedBy)
      expect(ticket?.worktreeId).toBeTruthy()
    })
  })

  // Issue #1: a session main treats as failed must not come up later, take the ticket prompt and
  // do the work unseen. Main's cancel closes it instead.
  test('a session main cancels is closed and never takes the ticket prompt', async () => {
    // The orchestrator opens at once; the ticket session stalls in its launch, as #14 did for minutes.
    const stalled = new Map<string, () => void>()
    const { agent, results, progress, start, cancel } = await render({
      create: vi.fn(async (created: AgentCreateRequest) => {
        const opened = { ok: true, status: 'ready' as const, sessionId: `conversation-${created.id}` }
        if (created.cwd !== request.worktree.path) return opened
        return new Promise<typeof opened>((resolve) => stalled.set(created.id, () => resolve(opened)))
      })
    })
    start('ticket-1')
    await waitFor(() => expect(stalled.size).toBe(1))
    const [[nodeId, finishStarting]] = [...stalled]
    expect((await screen.findAllByText('#34 Spawn')).length).toBeGreaterThan(0)
    // The node is reported the moment it exists, long before its session is up.
    expect(progress[0]).toEqual({ requestId: 'ticket-1', progress: { nodeId } })
    expect(progress.every((entry) => entry.progress.nodeId === nodeId)).toBe(true)

    await act(async () => cancel(nodeId))
    await waitFor(() => expect(agent.api.kill).toHaveBeenCalledWith(nodeId))
    expect(screen.queryAllByText('#34 Spawn')).toHaveLength(0)

    await act(async () => finishStarting())
    expect(vi.mocked(agent.api.prompt).mock.calls.filter(([id]) => id === nodeId)).toHaveLength(0)
    expect(results).toHaveLength(0)
  })

  // A Codex session has no conversation id until it opens, so one stopped at sign-in is reported
  // failed. Signing in later must not hand that untracked session the ticket.
  test('a session reported as failed never takes the ticket prompt afterwards', async () => {
    const { agent, results, start } = await render(
      {
        create: vi.fn(async (created: AgentCreateRequest) =>
          created.cwd === request.worktree.path
            ? { ok: true, status: 'auth_required' as const }
            : { ok: true, status: 'ready' as const, sessionId: `conversation-${created.id}` }
        )
      },
      'codex'
    )
    start('ticket-1', { ...request, provider: 'codex', orchestratedBy: { ...orchestratorLink, provider: 'codex' } })
    await waitFor(() => expect(results).toHaveLength(1))
    expect(results[0].result.ok).toBe(false)
    const nodeId = createRequests(agent).find((created) => created.cwd === request.worktree.path)!.id

    await act(async () => {
      agent.emit(nodeId, { type: 'session', sessionId: 'signed-in-conversation' })
      agent.emit(nodeId, { type: 'status', status: 'ready' })
    })
    await act(async () => undefined)
    expect(vi.mocked(agent.api.prompt).mock.calls.filter(([id]) => id === nodeId)).toHaveLength(0)
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

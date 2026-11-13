import { act, waitFor } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import type { HistoryRestoreRequest } from '../src/shared/remote-history'
import type { RemoteChatSpawnResult } from '../src/shared/remote-spawn'
import type { AgentProvider } from '../src/shared/agent-provider'
import type { WorkspaceState } from '../src/shared/workspace'
import type { AgentApi } from '../src/shared/agent'
import { createMockAgentApi } from './dom/agent-api-mock'
import { DEFAULT_PROJECT as project, renderApp, savedWorkspace } from './dom/app-harness'

async function harness(state: WorkspaceState = savedWorkspace(), overrides: Partial<AgentApi> = {}) {
  let open!: (requestId: string, request: HistoryRestoreRequest) => void
  const agent = createMockAgentApi(overrides)
  const complete = vi.fn()
  const publish = vi.fn()
  await renderApp({
    state,
    apis: {
      agentApi: agent.api as unknown as Record<string, unknown>,
      remoteApi: {
        onOpenHistory: (callback: typeof open) => {
          open = callback
          return () => undefined
        },
        completeOpenHistory: complete,
        publishWorkspace: publish
      }
    }
  })
  await waitFor(() => expect(open).toBeTypeOf('function'))
  return { open, agent, complete, publish }
}

function request(provider: AgentProvider, cwd = project.path): HistoryRestoreRequest {
  return {
    projectId: project.id,
    entry: {
      provider,
      id: 'original-conversation',
      title: 'Old conversation',
      titleSource: 'manual',
      path: 'C:/provider/transcript.jsonl',
      cwd,
      updatedAt: '2026-11-13T10:00:00Z',
      messageCount: 2
    }
  }
}

for (const provider of ['claude', 'codex'] as const) {
  test(`${provider}: concurrent restores create one original provider conversation and publish it before answering`, async () => {
    const h = await harness()
    act(() => {
      h.open('r1', request(provider))
      h.open('r2', request(provider))
    })
    await waitFor(() => expect(h.complete).toHaveBeenCalledTimes(2))
    expect(h.agent.api.create).toHaveBeenCalledTimes(1)
    const created = vi.mocked(h.agent.api.create).mock.calls[0][0]
    expect(created).toMatchObject({ provider, sessionId: 'original-conversation', cwd: project.path })
    const verdict = h.complete.mock.calls[0][1] as RemoteChatSpawnResult
    expect(verdict.ok).toBe(true)
    expect(h.complete.mock.calls[1][1]).toEqual(verdict)
    if (!verdict.ok) throw new Error('restore failed')
    expect(
      h.publish.mock.calls.some(([projection]) =>
        projection.chats.some((chat: { id: string }) => chat.id === verdict.chatId)
      )
    ).toBe(true)
    const listingIndex = h.publish.mock.calls.findIndex(([projection]) =>
      projection.chats.some((chat: { id: string }) => chat.id === verdict.chatId)
    )
    expect(h.publish.mock.invocationCallOrder[listingIndex]).toBeLessThan(h.complete.mock.invocationCallOrder[0])
    act(() => h.open('r3', request(provider)))
    await waitFor(() => expect(h.complete).toHaveBeenCalledTimes(3))
    expect(h.complete.mock.calls[2][1]).toEqual(verdict)
    expect(h.agent.api.create).toHaveBeenCalledTimes(1)
  })
}

test('an exited conversation resumes its existing node, without replacing another provider with the same id', async () => {
  const state = savedWorkspace({
    nodes: [
      {
        id: 'held',
        kind: 'codex',
        label: 'Existing',
        projectId: project.id,
        conversationId: 'original-conversation',
        position: { x: 0, y: 0 },
        width: 520,
        height: 340
      }
    ]
  })
  const h = await harness(state)
  await waitFor(() => expect(h.agent.api.create).toHaveBeenCalledTimes(1))
  act(() => h.agent.emit('held', { type: 'status', status: 'exited' }))
  act(() => h.open('held-request', request('codex')))
  await waitFor(() => expect(h.complete).toHaveBeenCalledWith('held-request', { ok: true, chatId: 'held' }))
  expect(h.agent.api.create).toHaveBeenCalledTimes(2)
  act(() => h.open('other-provider', request('claude')))
  await waitFor(() => expect(h.complete).toHaveBeenCalledTimes(2))
  expect(h.agent.api.create).toHaveBeenCalledTimes(3)
  expect(h.complete.mock.calls[1][1].chatId).not.toBe('held')
})

test('worktree history uses its exact cwd and attachment; an unavailable or vanished worktree refuses', async () => {
  const worktree = {
    id: 'w1',
    projectId: project.id,
    branch: 'feature',
    path: 'D:\\Development\\feature',
    baseRef: 'main',
    createdAt: '',
    position: { x: 0, y: 0 },
    width: 1000,
    height: 800
  }
  const h = await harness(savedWorkspace({ worktrees: [worktree] }))
  act(() => h.open('worktree', request('codex', worktree.path)))
  await waitFor(() => expect(h.complete).toHaveBeenCalledTimes(1))
  expect(vi.mocked(h.agent.api.create).mock.calls[0][0]).toMatchObject({
    cwd: worktree.path,
    sessionId: 'original-conversation'
  })
  act(() =>
    h.open('gone', {
      ...request('claude', 'D:\\Development\\missing-worktree'),
      entry: { ...request('claude').entry, cwd: 'D:\\Development\\missing-worktree' }
    })
  )
  expect(h.complete.mock.calls[1][1].ok).toBe(false)
  expect(h.agent.api.create).toHaveBeenCalledTimes(1)
})

test('a detached historical holder never silently accepts the project checkout from a phone', async () => {
  const state = savedWorkspace({
    nodes: [
      {
        id: 'detached',
        kind: 'codex',
        label: 'Detached',
        projectId: project.id,
        conversationId: 'original-conversation',
        worktreeId: 'missing',
        position: { x: 0, y: 0 },
        width: 520,
        height: 340
      }
    ]
  })
  const h = await harness(state)
  act(() => h.open('detached-request', request('codex')))
  expect(h.complete.mock.calls[0][1].ok).toBe(false)
  expect(h.agent.api.create).not.toHaveBeenCalled()
})

test('a failed provider resume refuses; retrying retains the same conversation and node', async () => {
  const create = vi
    .fn<AgentApi['create']>()
    .mockResolvedValueOnce({ ok: false, message: 'Transcript could not be loaded.' })
    .mockResolvedValue({ ok: true, status: 'ready' })
  const h = await harness(savedWorkspace(), { create })
  act(() => h.open('failed', request('codex')))
  await waitFor(() => expect(h.complete).toHaveBeenCalledTimes(1))
  expect(h.complete.mock.calls[0][1].ok).toBe(false)
  const originalNode = create.mock.calls[0][0].id
  act(() => h.open('retry', request('codex')))
  await waitFor(() => expect(h.complete).toHaveBeenCalledTimes(2))
  expect(h.complete.mock.calls[1][1]).toEqual({ ok: true, chatId: originalNode })
  expect(create.mock.calls[1][0]).toMatchObject({
    id: originalNode,
    sessionId: 'original-conversation',
    provider: 'codex'
  })
})

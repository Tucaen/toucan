import { act, renderHook, waitFor } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { useAgentConversation } from '../src/renderer/src/use-agent-conversation'
import { createMockAgentApi } from './dom/agent-api-mock'
import type { AgentCreateResult } from '../src/shared/agent'

// `transcriptPresence` decides whether a terminal-context adoption resumes a conversation or
// starts it new (#239), so it must never read "empty" for a conversation that has turns. Main
// sends the live `ready` status before `create()` settles, and a resume's replay only folds once
// it has - the gap in between is the window this pins shut.

function renderConversation() {
  return renderHook(() =>
    useAgentConversation({
      id: 'presence-node',
      provider: 'claude',
      cwd: '/project',
      sessionId: 'conversation-1',
      enabled: true,
      onSessionId: vi.fn(),
      onPermissionMode: vi.fn(),
      onModel: vi.fn()
    })
  )
}

test('stays unknown until the create result, replay included, has been applied', async () => {
  let settle: (result: AgentCreateResult) => void = () => undefined
  const { api, emit } = createMockAgentApi({
    create: vi.fn(() => new Promise<AgentCreateResult>((resolve) => (settle = resolve)))
  })
  window.agentApi = api
  const { result } = renderConversation()

  act(() => emit('presence-node', { type: 'status', status: 'ready' }))
  expect(result.current.status).toBe('ready')
  expect(result.current.messages).toEqual([])
  expect(result.current.transcriptPresence).toBeUndefined()

  await act(async () =>
    settle({
      ok: true,
      status: 'ready',
      sessionId: 'conversation-1',
      replay: [{ type: 'message', role: 'user', messageId: 'first', text: 'Hello' }]
    })
  )
  expect(result.current.transcriptPresence).toBe(true)
})

test('reads empty once a session with no turns has opened', async () => {
  const { api } = createMockAgentApi()
  window.agentApi = api
  const { result } = renderConversation()
  await waitFor(() => expect(result.current.transcriptPresence).toBe(false))
})

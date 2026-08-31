import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import { useAgentConversation } from '../src/renderer/src/use-agent-conversation'
import { createMockAgentApi } from './dom/agent-api-mock'

// ACP tool updates carry no timing, so the conversation hook is where a tool call acquires the
// start and end the card header shows (issue #87).

describe('activity timing', () => {
  test('the hook stamps a start when a call first appears and an end when it settles', async () => {
    const { api, emit } = createMockAgentApi()
    window.agentApi = api

    const { result } = renderHook(() =>
      useAgentConversation({
        id: 'session-timing',
        provider: 'claude',
        cwd: '/project',
        enabled: true,
        onSessionId: vi.fn(),
        onPermissionMode: vi.fn(),
        onModel: vi.fn()
      })
    )

    await waitFor(() => expect(result.current.status).toBe('ready'))

    act(() => {
      emit('session-timing', {
        type: 'activity',
        activity: { id: 'run-1', title: 'Ran the test suite', kind: 'execute', status: 'in_progress' }
      })
    })
    const started = result.current.activities[0]
    expect(typeof started.startedAt).toBe('number')
    expect(started.endedAt).toBeUndefined()

    act(() => {
      emit('session-timing', { type: 'activity', activity: { id: 'run-1', status: 'completed' } })
    })
    const finished = result.current.activities[0]
    expect(finished.startedAt).toBe(started.startedAt)
    expect(finished.endedAt).toBeGreaterThanOrEqual(started.startedAt!)
    // The patch-style update must not have cost the card its summary.
    expect(finished.title).toBe('Ran the test suite')
  })

  test('the hook stamps first-seen transcript events in arrival order', async () => {
    const { api, emit } = createMockAgentApi()
    window.agentApi = api

    const { result } = renderHook(() =>
      useAgentConversation({
        id: 'session-order',
        provider: 'claude',
        cwd: '/project',
        enabled: true,
        onSessionId: vi.fn(),
        onPermissionMode: vi.fn(),
        onModel: vi.fn()
      })
    )
    await waitFor(() => expect(result.current.status).toBe('ready'))

    act(() => {
      emit('session-order', { type: 'message', messageId: 'user-1', role: 'user', text: 'Prompt' })
      emit('session-order', {
        type: 'activity',
        activity: { id: 'tool-1', title: 'Read a file', status: 'in_progress' }
      })
      emit('session-order', { type: 'message', messageId: 'thought-1', role: 'thought', text: 'Thinking' })
      emit('session-order', { type: 'message', messageId: 'assistant-1', role: 'assistant', text: 'Response' })
    })

    expect(result.current.transcript).toEqual([
      { type: 'message', id: 'user-1', role: 'user' },
      { type: 'activity', id: 'tool-1' },
      { type: 'message', id: 'thought-1', role: 'thought' },
      { type: 'message', id: 'assistant-1', role: 'assistant' }
    ])

    act(() => {
      emit('session-order', { type: 'activity', activity: { id: 'tool-1', status: 'completed' } })
    })
    expect(result.current.transcript).toHaveLength(4)
  })
})

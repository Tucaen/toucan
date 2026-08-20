import { act, render, renderHook, screen, waitFor } from '@testing-library/react'
import type { FormEvent } from 'react'
import { describe, expect, test, vi } from 'vitest'
import { ChatView, type ChatViewProps } from '../src/renderer/src/ChatNode'
import { useAgentConversation } from '../src/renderer/src/use-agent-conversation'
import { createMockAgentApi } from './dom/agent-api-mock'

// Real-DOM companion to composer-queue-while-busy.test.ts: exercises the Composer's rendered
// disabled/queued-badge state and the useAgentConversation hook's queuing behavior by actually
// rendering/running them, instead of regex-matching their source text. The cross-process parts
// (preload/main/acp-session-manager IPC wiring) stay covered by source-text assertions over
// there, since jsdom can't exercise Electron IPC.

const baseChatViewProps: ChatViewProps = {
  provider: 'claude',
  messages: [],
  activities: [],
  plan: [],
  approval: null,
  authMethods: [],
  authLink: null,
  reauthenticating: false,
  status: 'ready',
  draft: '',
  imageSupport: false,
  attachments: [],
  setDraft: vi.fn(),
  addImages: vi.fn(),
  removeAttachment: vi.fn(),
  submit: vi.fn(),
  cancel: vi.fn(),
  authenticate: vi.fn(),
  openAuthLink: vi.fn(),
  resolveApproval: vi.fn(),
  sendMessage: vi.fn()
}

function renderChatView(overrides: Partial<ChatViewProps>): void {
  render(
    <ChatView
      {...baseChatViewProps}
      {...overrides}
      worklogCollapsed
      setWorklogCollapsed={vi.fn()}
    />
  )
}

describe('Composer disabled state', () => {
  test.each(['ready', 'working'] as const)('stays interactive while status is %s', (status) => {
    renderChatView({ status, draft: 'a message' })

    expect(screen.getByPlaceholderText(/message the agent|will be queued/i)).toBeEnabled()
    expect(screen.getByRole('button', { name: status === 'working' ? 'Queue' : 'Send' })).toBeEnabled()
  })

  test.each(['starting', 'auth_required', 'exited'] as const)('disables for status %s', (status) => {
    renderChatView({ status, draft: 'a message' })

    expect(screen.getByPlaceholderText(/message the agent|will be queued/i)).toBeDisabled()
  })
})

test('a queued message renders a queued-badge distinguishing it from a delivered one', () => {
  renderChatView({
    messages: [
      { id: 'sent', role: 'user', text: 'already delivered' },
      { id: 'pending', role: 'user', text: 'still queued', queued: true }
    ]
  })

  expect(screen.queryByText('Queued — will send once the agent is free')).toBeInTheDocument()
  const deliveredArticle = screen.getByText('already delivered').closest('article')
  expect(deliveredArticle?.querySelector('.queued-badge')).toBeNull()
  const queuedArticle = screen.getByText('still queued').closest('article')
  expect(queuedArticle?.querySelector('.queued-badge')).not.toBeNull()
})

function fakeSubmitEvent(): FormEvent {
  return { preventDefault: () => {} } as unknown as FormEvent
}

test('submit() delivers directly while ready, then queues through promptWhenIdle once working', async () => {
  const { api, emit } = createMockAgentApi()
  window.agentApi = api

  const { result } = renderHook(() => useAgentConversation({
    id: 'session-1',
    provider: 'claude',
    cwd: '/project',
    enabled: true,
    onSessionId: vi.fn(),
    onPermissionMode: vi.fn(),
    onModel: vi.fn()
  }))

  await waitFor(() => expect(result.current.status).toBe('ready'))

  act(() => result.current.setDraft('first message'))
  act(() => { result.current.submit(fakeSubmitEvent()) })

  await waitFor(() => expect(result.current.status).toBe('working'))
  await waitFor(() => expect(api.prompt).toHaveBeenCalledWith('session-1', 'first message'))
  await waitFor(() => expect(result.current.messages).toEqual([
    { id: expect.any(String), role: 'user', text: 'first message', queued: false }
  ]))

  act(() => result.current.setDraft('second message'))
  act(() => { result.current.submit(fakeSubmitEvent()) })

  await waitFor(() => expect(api.promptWhenIdle).toHaveBeenCalledWith('session-1', 'second message'))
  expect(result.current.status).toBe('working')
  await waitFor(() => expect(result.current.messages).toEqual([
    { id: expect.any(String), role: 'user', text: 'first message', queued: false },
    { id: expect.any(String), role: 'user', text: 'second message', queued: true }
  ]))

  // The agent echoes sends in FIFO order: the still-open "first message" slot must clear
  // before "second message"'s can, even though "first message" was never itself queued.
  emit('session-1', { type: 'message', role: 'user', messageId: 'echo-1', text: 'first message' })
  emit('session-1', { type: 'message', role: 'user', messageId: 'echo-2', text: 'second message' })
  await waitFor(() => expect(result.current.messages[1].queued).toBe(false))
  expect(result.current.messages[0].queued).toBe(false)
})

test('each queued send clears its own queued flag independently, in the order the agent echoes them', async () => {
  const { api, emit } = createMockAgentApi()
  window.agentApi = api

  const { result } = renderHook(() => useAgentConversation({
    id: 'session-2',
    provider: 'claude',
    cwd: '/project',
    enabled: true,
    onSessionId: vi.fn(),
    onPermissionMode: vi.fn(),
    onModel: vi.fn()
  }))

  await waitFor(() => expect(result.current.status).toBe('ready'))

  act(() => result.current.setDraft('go ready-to-working'))
  act(() => { result.current.submit(fakeSubmitEvent()) })
  await waitFor(() => expect(result.current.status).toBe('working'))

  act(() => result.current.setDraft('queued A'))
  act(() => { result.current.submit(fakeSubmitEvent()) })
  act(() => result.current.setDraft('queued B'))
  act(() => { result.current.submit(fakeSubmitEvent()) })

  await waitFor(() => expect(result.current.messages).toHaveLength(3))
  await waitFor(() => expect(result.current.messages[1].queued).toBe(true))
  await waitFor(() => expect(result.current.messages[2].queued).toBe(true))

  // "go ready-to-working" holds the head of the FIFO until it's echoed too, even though it
  // wasn't itself queued.
  emit('session-2', { type: 'message', role: 'user', messageId: 'echo-0', text: 'go ready-to-working' })
  emit('session-2', { type: 'message', role: 'user', messageId: 'echo-A', text: 'queued A' })
  await waitFor(() => expect(result.current.messages[1].queued).toBe(false))
  expect(result.current.messages[2].queued).toBe(true)

  emit('session-2', { type: 'message', role: 'user', messageId: 'echo-B', text: 'queued B' })
  await waitFor(() => expect(result.current.messages[2].queued).toBe(false))
})

import { act, render, renderHook, screen, waitFor } from '@testing-library/react'
import type { FormEvent } from 'react'
import { describe, expect, test, vi } from 'vitest'
import { TestChatView as ChatView, type TestChatViewProps as ChatViewProps } from './dom/chat-view-fixture'
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
  sendMessage: vi.fn(),
  answerDecision: vi.fn(),
  queued: [],
  editQueued: vi.fn(),
  withdrawQueued: vi.fn(),
  sendQueuedNow: vi.fn()
}

function renderChatView(overrides: Partial<ChatViewProps>): void {
  render(<ChatView {...baseChatViewProps} {...overrides} focusMode={false} setFocusMode={vi.fn()} />)
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

test('working and expired-queue notices render together above the bordered input row', () => {
  const expired = 'A queued message expired because the agent did not become idle in time.'
  renderChatView({ status: 'working', detail: expired, draft: 'user-entered text' })

  const textarea = screen.getByRole('textbox')
  const notices = screen.getByRole('status')
  const inputRow = textarea.closest('.chat-composer-row')

  expect(textarea).toHaveValue('user-entered text')
  expect(textarea).toHaveAttribute('placeholder', 'Message the agent...')
  expect(notices).toHaveTextContent(expired)
  expect(notices).toHaveTextContent('Agent is working... your message will be queued')
  expect(notices).toHaveClass('composer-notices')
  expect(notices.compareDocumentPosition(inputRow as Node) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(inputRow).not.toContainElement(notices)
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

test('a failed message renders a distinct failed-badge, never the queued-badge', () => {
  renderChatView({
    messages: [
      { id: 'sent', role: 'user', text: 'already delivered' },
      { id: 'dropped', role: 'user', text: 'never arrived', failed: true }
    ]
  })

  const deliveredArticle = screen.getByText('already delivered').closest('article')
  expect(deliveredArticle?.querySelector('.failed-badge')).toBeNull()
  const failedArticle = screen.getByText('never arrived').closest('article')
  expect(failedArticle?.querySelector('.queued-badge')).toBeNull()
  expect(failedArticle?.querySelector('.failed-badge')).not.toBeNull()
  expect(screen.getByText('Not sent — delivery was rejected')).toBeInTheDocument()
})

function fakeSubmitEvent(): FormEvent {
  return { preventDefault: () => {} } as unknown as FormEvent
}

test('submit() delivers directly while ready, and holds the next one locally once working', async () => {
  const { api, emit } = createMockAgentApi()
  window.agentApi = api

  const { result } = renderHook(() =>
    useAgentConversation({
      id: 'session-1',
      provider: 'claude',
      cwd: '/project',
      enabled: true,
      onSessionId: vi.fn(),
      onPermissionMode: vi.fn(),
      onModel: vi.fn()
    })
  )

  await waitFor(() => expect(result.current.status).toBe('ready'))

  act(() => result.current.setDraft('first message'))
  act(() => {
    result.current.submit(fakeSubmitEvent())
  })

  await waitFor(() => expect(result.current.status).toBe('working'))
  await waitFor(() => expect(api.prompt).toHaveBeenCalledWith('session-1', 'first message'))
  await waitFor(() =>
    expect(result.current.messages).toEqual([
      { id: expect.any(String), role: 'user', text: 'first message', queued: false }
    ])
  )

  // A follow-up submitted mid-turn is parked in the local outbox: nothing crosses into the
  // adapter, which is exactly what makes it withdrawable.
  act(() => result.current.setDraft('second message'))
  act(() => {
    result.current.submit(fakeSubmitEvent())
  })

  expect(result.current.queued.map((entry) => entry.text)).toEqual(['second message'])
  expect(api.promptWhenIdle).not.toHaveBeenCalled()
  expect(result.current.status).toBe('working')
  expect(result.current.messages).toHaveLength(1)

  // Once the turn finishes, the outbox drains through the ordinary direct API.
  emit('session-1', { type: 'status', status: 'idle' })
  await waitFor(() => expect(api.prompt).toHaveBeenCalledWith('session-1', 'second message'))
  await waitFor(() => expect(result.current.queued).toEqual([]))
  await waitFor(() =>
    expect(result.current.messages).toEqual([
      { id: expect.any(String), role: 'user', text: 'first message', queued: false },
      { id: expect.any(String), role: 'user', text: 'second message', queued: false }
    ])
  )
})

test('a queued follow-up can be withdrawn, and the agent never sees it', async () => {
  const { api, emit } = createMockAgentApi()
  window.agentApi = api

  const { result } = renderHook(() =>
    useAgentConversation({
      id: 'session-withdraw',
      provider: 'claude',
      cwd: '/project',
      enabled: true,
      onSessionId: vi.fn(),
      onPermissionMode: vi.fn(),
      onModel: vi.fn()
    })
  )

  await waitFor(() => expect(result.current.status).toBe('ready'))
  act(() => result.current.setDraft('go ready-to-working'))
  act(() => {
    result.current.submit(fakeSubmitEvent())
  })
  await waitFor(() => expect(result.current.status).toBe('working'))

  act(() => result.current.setDraft('please also refactor everything'))
  act(() => {
    result.current.submit(fakeSubmitEvent())
  })
  const [entry] = result.current.queued
  act(() => result.current.withdrawQueued(entry.id))

  expect(result.current.queued).toEqual([])

  // The turn ends: there is nothing left to drain, so the withdrawn text is never delivered.
  emit('session-withdraw', { type: 'status', status: 'idle' })
  await waitFor(() => expect(result.current.status).toBe('ready'))
  expect(api.prompt).not.toHaveBeenCalledWith('session-withdraw', 'please also refactor everything')
  expect(api.promptWhenIdle).not.toHaveBeenCalled()
})

test('a queued follow-up can be rewritten before it is sent, and only the rewrite is delivered', async () => {
  const { api, emit } = createMockAgentApi()
  window.agentApi = api

  const { result } = renderHook(() =>
    useAgentConversation({
      id: 'session-edit',
      provider: 'claude',
      cwd: '/project',
      enabled: true,
      onSessionId: vi.fn(),
      onPermissionMode: vi.fn(),
      onModel: vi.fn()
    })
  )

  await waitFor(() => expect(result.current.status).toBe('ready'))
  act(() => result.current.setDraft('go ready-to-working'))
  act(() => {
    result.current.submit(fakeSubmitEvent())
  })
  await waitFor(() => expect(result.current.status).toBe('working'))

  act(() => result.current.setDraft('first draft of the follow-up'))
  act(() => {
    result.current.submit(fakeSubmitEvent())
  })
  act(() => result.current.editQueued(result.current.queued[0].id, 'the follow-up I actually meant'))

  emit('session-edit', { type: 'status', status: 'idle' })
  await waitFor(() => expect(api.prompt).toHaveBeenCalledWith('session-edit', 'the follow-up I actually meant'))
  expect(api.prompt).not.toHaveBeenCalledWith('session-edit', 'first draft of the follow-up')
})

test('sendQueuedNow hands one queued prompt to the running turn through promptWhenIdle', async () => {
  const { api } = createMockAgentApi()
  window.agentApi = api

  const { result } = renderHook(() =>
    useAgentConversation({
      id: 'session-now',
      provider: 'claude',
      cwd: '/project',
      enabled: true,
      onSessionId: vi.fn(),
      onPermissionMode: vi.fn(),
      onModel: vi.fn()
    })
  )

  await waitFor(() => expect(result.current.status).toBe('ready'))
  act(() => result.current.setDraft('go ready-to-working'))
  act(() => {
    result.current.submit(fakeSubmitEvent())
  })
  await waitFor(() => expect(result.current.status).toBe('working'))

  act(() => result.current.setDraft('steer the running turn'))
  act(() => {
    result.current.submit(fakeSubmitEvent())
  })
  act(() => result.current.sendQueuedNow(result.current.queued[0].id))

  await waitFor(() => expect(api.promptWhenIdle).toHaveBeenCalledWith('session-now', 'steer the running turn'))
  expect(result.current.queued).toEqual([])
})

test('a decision answer given mid-turn still goes straight into the running turn, never the outbox', async () => {
  const { api } = createMockAgentApi()
  window.agentApi = api

  const { result } = renderHook(() =>
    useAgentConversation({
      id: 'session-decision',
      provider: 'claude',
      cwd: '/project',
      enabled: true,
      onSessionId: vi.fn(),
      onPermissionMode: vi.fn(),
      onModel: vi.fn()
    })
  )

  await waitFor(() => expect(result.current.status).toBe('ready'))
  act(() => result.current.setDraft('go ready-to-working'))
  act(() => {
    result.current.submit(fakeSubmitEvent())
  })
  await waitFor(() => expect(result.current.status).toBe('working'))

  act(() => {
    result.current.answerDecision('decision-1', 'Option B')
  })

  await waitFor(() => expect(api.promptWhenIdle).toHaveBeenCalledWith('session-decision', 'Option B'))
  expect(result.current.queued).toEqual([])
})

test('the host-authored user message consumes the optimistic bubble for composed prompts and decision replies alike', async () => {
  // Main publishes one `role: 'user'` message per accepted prompt (the same event every remote
  // client folds). The desktop already drew its own bubble - with UI metadata a host event cannot
  // carry - so that event must land as the echo of the local message, never as a second one.
  const { api, emit } = createMockAgentApi()
  window.agentApi = api

  const { result } = renderHook(() =>
    useAgentConversation({
      id: 'session-host-echo',
      provider: 'claude',
      cwd: '/project',
      enabled: true,
      composePrompt: (text) => `[with context] ${text}`,
      onSessionId: vi.fn(),
      onPermissionMode: vi.fn(),
      onModel: vi.fn()
    })
  )

  await waitFor(() => expect(result.current.status).toBe('ready'))
  act(() => result.current.setDraft('typed on the desktop'))
  act(() => {
    result.current.submit(fakeSubmitEvent())
  })
  await waitFor(() =>
    expect(api.prompt).toHaveBeenCalledWith('session-host-echo', '[with context] typed on the desktop')
  )

  // The host publishes what the agent actually received, which is the composed prompt.
  emit('session-host-echo', {
    type: 'message',
    role: 'user',
    messageId: 'host-1',
    text: '[with context] typed on the desktop'
  })
  await waitFor(() =>
    expect(result.current.messages).toEqual([expect.objectContaining({ role: 'user', queued: false })])
  )
  expect(result.current.messages[0].text).toBe('typed on the desktop')

  act(() => {
    result.current.answerDecision('decision-1', 'Option B')
  })
  await waitFor(() => expect(result.current.messages).toHaveLength(2))
  expect(result.current.messages[1]).toEqual(
    expect.objectContaining({ text: 'Option B', decisionReplyTo: 'decision-1' })
  )

  emit('session-host-echo', { type: 'message', role: 'user', messageId: 'host-2', text: '[with context] Option B' })
  await waitFor(() => expect(result.current.messages[1].deliveryPending).toBeUndefined())
  expect(result.current.messages).toHaveLength(2)
  expect(result.current.messages[1]).toEqual(
    expect.objectContaining({ text: 'Option B', decisionReplyTo: 'decision-1', queued: false })
  )
})

test('each accepted queued send is acknowledged independently and later echoes are deduplicated', async () => {
  const { api, emit } = createMockAgentApi()
  window.agentApi = api

  const { result } = renderHook(() =>
    useAgentConversation({
      id: 'session-2',
      provider: 'claude',
      cwd: '/project',
      enabled: true,
      onSessionId: vi.fn(),
      onPermissionMode: vi.fn(),
      onModel: vi.fn()
    })
  )

  await waitFor(() => expect(result.current.status).toBe('ready'))

  act(() => result.current.setDraft('go ready-to-working'))
  act(() => {
    result.current.submit(fakeSubmitEvent())
  })
  await waitFor(() => expect(result.current.status).toBe('working'))

  act(() => {
    result.current.sendMessage('queued A')
  })
  act(() => {
    result.current.sendMessage('queued B')
  })

  await waitFor(() => expect(result.current.messages).toHaveLength(3))
  await waitFor(() => expect(result.current.messages[1].queued).toBe(false))
  await waitFor(() => expect(result.current.messages[2].queued).toBe(false))

  // Echoes happen to arrive in submission order here, but the matcher no longer requires it
  // (see the "out of order" test below) - it just needs each echo's text to match some pending
  // entry.
  emit('session-2', { type: 'message', role: 'user', messageId: 'echo-0', text: 'go ready-to-working' })
  emit('session-2', { type: 'message', role: 'user', messageId: 'echo-A', text: 'queued A' })
  await waitFor(() => expect(result.current.messages[1].queued).toBe(false))
  expect(result.current.messages).toHaveLength(3)

  emit('session-2', { type: 'message', role: 'user', messageId: 'echo-B', text: 'queued B' })
  await waitFor(() => expect(result.current.messages[2].queued).toBe(false))
})

test('a missing echo for an earlier queued message does not block a later message from clearing its own badge', async () => {
  // Reproduces the "queued badge never clears" symptom: with a head-of-FIFO-only match, once
  // one entry's echo is missed or mismatched, every entry behind it is permanently stuck too,
  // even though the agent has genuinely finished with each of them (status recovers to
  // "Ready" while the badge stays stuck). The fix matches an incoming echo against any pending
  // entry, not just the head, so a later message's own echo still clears it.
  const { api, emit } = createMockAgentApi()
  window.agentApi = api

  const { result } = renderHook(() =>
    useAgentConversation({
      id: 'session-3',
      provider: 'claude',
      cwd: '/project',
      enabled: true,
      onSessionId: vi.fn(),
      onPermissionMode: vi.fn(),
      onModel: vi.fn(),
      // Long enough that the fallback timeout (tested separately below) can't be what clears
      // "queued B" here - only the order-independent match can.
      pendingEchoTimeoutMs: 60_000
    })
  )

  await waitFor(() => expect(result.current.status).toBe('ready'))

  act(() => result.current.setDraft('go ready-to-working'))
  act(() => {
    result.current.submit(fakeSubmitEvent())
  })
  await waitFor(() => expect(result.current.status).toBe('working'))

  act(() => {
    result.current.sendMessage('queued A')
  })
  act(() => {
    result.current.sendMessage('queued B')
  })

  await waitFor(() => expect(result.current.messages).toHaveLength(3))

  // "go ready-to-working"'s own echo never arrives at all, and "queued A"'s is skipped too -
  // only "queued B"'s echo shows up. It must still clear "queued B"'s badge.
  emit('session-3', { type: 'message', role: 'user', messageId: 'echo-B', text: 'queued B' })
  await waitFor(() => expect(result.current.messages[2].queued).toBe(false))
  expect(result.current.messages[1].queued).toBe(false)
})

test('a queued message whose echo never arrives at all still clears its badge via the fallback timeout', async () => {
  // Reproduces the other half of the same symptom: an echo that is missed entirely (not just
  // out of order) previously left that message's own badge - and, transitively, every later
  // one - queued forever. The fallback timeout force-clears it even with no echo at all.
  const { api } = createMockAgentApi()
  window.agentApi = api

  const { result } = renderHook(() =>
    useAgentConversation({
      id: 'session-4',
      provider: 'claude',
      cwd: '/project',
      enabled: true,
      onSessionId: vi.fn(),
      onPermissionMode: vi.fn(),
      onModel: vi.fn(),
      pendingEchoTimeoutMs: 20
    })
  )

  await waitFor(() => expect(result.current.status).toBe('ready'))

  act(() => result.current.setDraft('go ready-to-working'))
  act(() => {
    result.current.submit(fakeSubmitEvent())
  })
  await waitFor(() => expect(result.current.status).toBe('working'))

  act(() => {
    result.current.sendMessage('queued, echo will never arrive')
  })
  await waitFor(() => expect(result.current.messages).toHaveLength(2))
  expect(result.current.messages[1].queued).toBe(false)

  // No echo is ever emitted for this send - simulates the ACP layer failing to echo it back.
  await waitFor(() => expect(result.current.messages[1].queued).toBe(false))
})

test('a queued send that expires in the wake gate before reaching the agent renders as failed, not delivered', async () => {
  // Reproduces the "failed queued message looks delivered" symptom: a message queued behind a
  // still-working turn can be resolved with ok:false by the wake gate's own timeout (e.g. it
  // expired before ever reaching the agent) well before that turn itself times out. That must
  // never look identical to a message the agent actually processed.
  const { api, emit } = createMockAgentApi({
    promptWhenIdle: vi.fn(async () => ({ ok: false, message: 'expired' }))
  })
  window.agentApi = api

  const { result } = renderHook(() =>
    useAgentConversation({
      id: 'session-5',
      provider: 'claude',
      cwd: '/project',
      enabled: true,
      onSessionId: vi.fn(),
      onPermissionMode: vi.fn(),
      onModel: vi.fn()
    })
  )

  await waitFor(() => expect(result.current.status).toBe('ready'))

  act(() => result.current.setDraft('go ready-to-working'))
  act(() => {
    result.current.submit(fakeSubmitEvent())
  })
  await waitFor(() => expect(result.current.status).toBe('working'))

  act(() => {
    result.current.sendMessage('queued, will expire')
  })
  await waitFor(() => expect(result.current.messages).toHaveLength(2))

  await waitFor(() => expect(result.current.messages[1].failed).toBe(true))
  expect(result.current.messages[1].queued).toBe(false)

  // The head-of-queue turn eventually completes for real - its own echo must not resurrect the
  // expired message's badge as if it had been delivered after all.
  emit('session-5', { type: 'message', role: 'user', messageId: 'echo-0', text: 'go ready-to-working' })
  expect(result.current.messages[1].failed).toBe(true)
  expect(result.current.messages[1].queued).toBe(false)

  // If ACP later proves that this exact message was accepted after all, reconciliation is
  // monotonic toward acknowledgement: the stale failure presentation must disappear and the
  // echoed message must not be duplicated in the transcript.
  emit('session-5', { type: 'message', role: 'user', messageId: 'late-own-echo', text: 'queued, will expire' })
  await waitFor(() => expect(result.current.messages[1].failed).toBeUndefined())
  expect(result.current.messages.filter((message) => message.text === 'queued, will expire')).toHaveLength(1)
})

test('a turn failure after ACP echoed the user message does not relabel the accepted message as not sent', async () => {
  let resolveTurn: ((result: { ok: boolean; message?: string }) => void) | undefined
  const { api, emit } = createMockAgentApi({
    prompt: vi.fn(
      () =>
        new Promise((resolve) => {
          resolveTurn = resolve
        })
    )
  })
  window.agentApi = api

  const { result } = renderHook(() =>
    useAgentConversation({
      id: 'session-accepted-before-turn-failure',
      provider: 'claude',
      cwd: '/project',
      enabled: true,
      onSessionId: vi.fn(),
      onPermissionMode: vi.fn(),
      onModel: vi.fn()
    })
  )

  await waitFor(() => expect(result.current.status).toBe('ready'))

  act(() => result.current.setDraft('/$toucan-project-skills:implement-in-worktree the idea written down in…'))
  act(() => {
    result.current.submit(fakeSubmitEvent())
  })
  await waitFor(() => expect(result.current.messages).toHaveLength(1))

  emit('session-accepted-before-turn-failure', {
    type: 'message',
    role: 'user',
    messageId: 'accepted-prompt',
    text: '/$toucan-project-skills:implement-in-worktree the idea written down in…'
  })
  resolveTurn?.({ ok: false, message: 'The agent turn failed after accepting the prompt.' })

  await waitFor(() => expect(result.current.detail).toBe('The agent turn failed after accepting the prompt.'))
  expect(result.current.messages[0].failed).toBeUndefined()
})

test('a queued send does not fire its echo fallback while promptWhenIdle is still pending', async () => {
  // Reproduces a race left by an earlier version of the fallback: it started counting down as
  // soon as the deliver call was *issued*, not once it actually settled. A queued send's
  // promptWhenIdle promise only resolves once the wake gate genuinely dispatches it (see
  // firstmate-captain-wake.ts), which routinely takes far longer than the fallback timeout -
  // so the fallback fired while the message was still legitimately queued, clearing its badge
  // early and duplicating it once the real echo eventually arrived.
  let resolveDelivery: ((result: { ok: boolean }) => void) | undefined
  const { api } = createMockAgentApi({
    promptWhenIdle: vi.fn(
      () =>
        new Promise((resolve) => {
          resolveDelivery = resolve
        })
    )
  })
  window.agentApi = api

  const { result } = renderHook(() =>
    useAgentConversation({
      id: 'session-6',
      provider: 'claude',
      cwd: '/project',
      enabled: true,
      onSessionId: vi.fn(),
      onPermissionMode: vi.fn(),
      onModel: vi.fn(),
      pendingEchoTimeoutMs: 20
    })
  )

  await waitFor(() => expect(result.current.status).toBe('ready'))

  act(() => result.current.setDraft('go ready-to-working'))
  act(() => {
    result.current.submit(fakeSubmitEvent())
  })
  await waitFor(() => expect(result.current.status).toBe('working'))

  act(() => {
    result.current.sendMessage('queued, still waiting on delivery')
  })
  await waitFor(() => expect(result.current.messages).toHaveLength(2))
  expect(result.current.messages[1].queued).toBe(true)

  // Long enough that the fallback would already have fired if it were (incorrectly) armed at
  // submission time, even though promptWhenIdle itself hasn't resolved yet.
  await new Promise((resolve) => setTimeout(resolve, 100))
  expect(result.current.messages[1].queued).toBe(true)

  resolveDelivery?.({ ok: true })
  await waitFor(() => expect(result.current.messages[1].queued).toBe(false))
})

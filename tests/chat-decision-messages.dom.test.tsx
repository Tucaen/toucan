import { act, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import { ChatView, type ChatViewProps } from '../src/renderer/src/ChatNode'
import { useAgentConversation } from '../src/renderer/src/use-agent-conversation'
import { createMockAgentApi } from './dom/agent-api-mock'

// Covers the captain-facing part of decision messages: a decision-shaped assistant message gets
// distinct ("decision") styling and clickable option buttons, a routine/noise message gets muted
// ("noise") styling, an ordinary reply gets neither, and clicking an option (or submitting the
// "Other" field) sends that text through the normal submit path. See decision-message.ts for the
// classification heuristic and ChatNode.tsx's ChatMessageCard/DecisionOptions for the rendering.

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
  render(
    <ChatView
      {...baseChatViewProps}
      {...overrides}
      worklogCollapsed
      setWorklogCollapsed={vi.fn()}
    />
  )
}

const decisionText = [
  'The lint gate failed on an unused import. I can:',
  '',
  '- **Fix it now**: remove the unused import and rerun the gate',
  '- **Skip it**: leave the file as-is and move on',
  '',
  'Which would you like?'
].join('\n')

const noiseText = 'Spawning worker for task fm-142 in the alpha project.'

const normalText = 'Here is a summary of what changed: the auth middleware now checks token expiry before refresh.'

describe('assistant message tone rendering', () => {
  test('a decision-shaped message gets decision styling and clickable options', () => {
    renderChatView({ messages: [{ id: 'm1', role: 'assistant', text: decisionText }] })

    const article = screen.getAllByText(/Which would you like/)[0]?.closest('article')
    expect(article).toHaveAttribute('data-tone', 'decision')
    expect(screen.getByRole('button', { name: /Fix it now/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Skip it/ })).toBeInTheDocument()
    expect(screen.getByPlaceholderText('Other…')).toBeInTheDocument()
  })

  test('a routine/noise message gets muted styling and no option buttons', () => {
    renderChatView({ messages: [{ id: 'm2', role: 'assistant', text: noiseText }] })

    const article = screen.getByText(noiseText).closest('article')
    expect(article).toHaveAttribute('data-tone', 'noise')
    expect(article?.querySelector('.decision-options')).toBeNull()
  })

  test('a normal conversational reply gets neither decision nor noise treatment', () => {
    renderChatView({ messages: [{ id: 'm3', role: 'assistant', text: normalText }] })

    const article = screen.getByText(normalText).closest('article')
    expect(article).toHaveAttribute('data-tone', 'normal')
    expect(article?.querySelector('.decision-options')).toBeNull()
  })

  test('user messages never get a decision/noise tone even if the text happens to match the shape', () => {
    renderChatView({ messages: [{ id: 'm4', role: 'user', text: decisionText }] })

    const article = screen.getByText(/Which would you like/).closest('article')
    expect(article).toHaveAttribute('data-tone', 'normal')
    expect(article?.querySelector('.decision-options')).toBeNull()
  })
})

describe('decision option interaction', () => {
  test('clicking an option calls sendMessage with that option\'s text', () => {
    const answerDecision = vi.fn()
    renderChatView({
      messages: [{ id: 'm5', role: 'assistant', text: decisionText }],
      answerDecision
    })

    fireEvent.click(screen.getByRole('button', { name: /Fix it now/ }))

    expect(answerDecision).toHaveBeenCalledWith(
      expect.stringMatching(/^text:/),
      'Fix it now: remove the unused import and rerun the gate'
    )
  })

  test('submitting the "Other" field sends the typed free text', () => {
    const answerDecision = vi.fn()
    renderChatView({
      messages: [{ id: 'm6', role: 'assistant', text: decisionText }],
      answerDecision
    })

    const input = screen.getByPlaceholderText('Other…')
    fireEvent.change(input, { target: { value: 'Do something else entirely' } })
    const otherForm = within(input.closest('form')!)
    const sendButton = otherForm.getByRole('button', { name: 'Send' })
    expect(sendButton).toBeEnabled()
    fireEvent.click(sendButton)

    expect(answerDecision).toHaveBeenCalledWith(expect.stringMatching(/^text:/), 'Do something else entirely')
  })

  test('option buttons and the "Other" field are disabled when the session cannot accept messages', () => {
    const answerDecision = vi.fn()
    renderChatView({
      messages: [{ id: 'm7', role: 'assistant', text: decisionText }],
      answerDecision,
      status: 'exited'
    })

    const optionButton = screen.getByRole('button', { name: /Fix it now/ })
    expect(optionButton).toBeDisabled()
    fireEvent.click(optionButton)
    expect(answerDecision).not.toHaveBeenCalled()

    const input = screen.getByPlaceholderText('Other…')
    expect(input).toBeDisabled()
    const otherForm = within(input.closest('form')!)
    expect(otherForm.getByRole('button', { name: 'Send' })).toBeDisabled()
  })

  test('an option click sends through the same path as typing and submitting into the composer', async () => {
    const { api, emit } = createMockAgentApi()
    window.agentApi = api

    const { result } = renderHook(() => useAgentConversation({
      id: 'session-decision',
      provider: 'claude',
      cwd: '/project',
      enabled: true,
      onSessionId: vi.fn(),
      onPermissionMode: vi.fn(),
      onModel: vi.fn()
    }))

    await waitFor(() => expect(result.current.status).toBe('ready'))

    act(() => { result.current.sendMessage('Fix it now: remove the unused import and rerun the gate') })

    await waitFor(() => expect(api.prompt).toHaveBeenCalledWith(
      'session-decision',
      'Fix it now: remove the unused import and rerun the gate'
    ))
    await waitFor(() => expect(result.current.messages).toEqual([
      { id: expect.any(String), role: 'user', text: 'Fix it now: remove the unused import and rerun the gate', queued: false }
    ]))
    // sendMessage never touches the draft, unlike submit()'s clear-on-send behavior.
    expect(result.current.draft).toBe('')

    emit('session-decision', {
      type: 'message',
      role: 'user',
      messageId: 'echo-decision',
      text: 'Fix it now: remove the unused import and rerun the gate'
    })
  })

  test.each(['claude', 'codex'] as const)('keeps %s decision controls pinned outside the transcript', (provider) => {
    renderChatView({ provider, messages: [{ id: `${provider}-decision`, role: 'assistant', text: decisionText }] })
    const pin = screen.getByRole('region', { name: 'Pending decisions' })
    expect(pin).toBeInTheDocument()
    expect(pin.closest('.chat-scroll')).toBeNull()
    expect(within(pin).getByPlaceholderText('Other…')).toBeEnabled()
  })

  test('a decision answer is submitting until accepted and a rejected answer becomes actionable again', async () => {
    let settle: ((result: { ok: boolean; message?: string }) => void) | undefined
    const prompt = vi.fn(() => new Promise<{ ok: boolean; message?: string }>((resolve) => { settle = resolve }))
    const { api, emit } = createMockAgentApi({ prompt })
    window.agentApi = api
    const { result } = renderHook(() => useAgentConversation({
      id: 'session-pending-decision', provider: 'codex', cwd: '/project', enabled: true,
      onSessionId: vi.fn(), onPermissionMode: vi.fn(), onModel: vi.fn()
    }))
    await waitFor(() => expect(result.current.status).toBe('ready'))

    act(() => result.current.answerDecision('beta:rollout', 'Gradual'))
    await waitFor(() => expect(result.current.messages[0]).toMatchObject({
      decisionReplyTo: 'beta:rollout', deliveryPending: true, queued: false
    }))
    act(() => settle?.({ ok: false, message: 'Captain transport rejected the answer' }))
    await waitFor(() => expect(result.current.messages[0]).toMatchObject({
      decisionReplyTo: 'beta:rollout', deliveryPending: false, failed: true, queued: false
    }))

    emit('session-pending-decision', { type: 'status', status: 'working' })
    expect(result.current.detail).toBe('Captain transport rejected the answer')
  })

  test('answering while Working uses the normal steering queue exactly once', async () => {
    const { api, emit } = createMockAgentApi()
    window.agentApi = api
    const { result } = renderHook(() => useAgentConversation({
      id: 'session-working-decision', provider: 'claude', cwd: '/project', enabled: true,
      onSessionId: vi.fn(), onPermissionMode: vi.fn(), onModel: vi.fn()
    }))
    await waitFor(() => expect(result.current.status).toBe('ready'))
    act(() => emit('session-working-decision', { type: 'status', status: 'working' }))
    act(() => result.current.answerDecision('alpha:storage', 'SQLite'))
    await waitFor(() => expect(api.promptWhenIdle).toHaveBeenCalledWith('session-working-decision', 'SQLite'))
    expect(api.prompt).not.toHaveBeenCalled()
    expect(api.promptWhenIdle).toHaveBeenCalledTimes(1)
  })

  test.each(['claude', 'codex'] as const)('%s streamed assistant chunks finalize only at turn completion', async (provider) => {
    const { api, emit } = createMockAgentApi()
    window.agentApi = api
    const id = `session-stream-${provider}`
    const { result } = renderHook(() => useAgentConversation({
      id, provider, cwd: '/project', enabled: true,
      onSessionId: vi.fn(), onPermissionMode: vi.fn(), onModel: vi.fn()
    }))
    await waitFor(() => expect(result.current.status).toBe('ready'))
    act(() => {
      emit(id, { type: 'message', role: 'assistant', messageId: `${provider}-real-message-id`, text: decisionText.slice(0, 35) })
      emit(id, { type: 'message', role: 'assistant', messageId: `${provider}-real-message-id`, text: decisionText.slice(35) })
    })
    expect(result.current.messages).toEqual([expect.objectContaining({ text: decisionText, complete: false })])
    act(() => emit(id, { type: 'turn_complete', stopReason: 'end_turn' }))
    expect(result.current.messages).toEqual([expect.objectContaining({ text: decisionText, complete: true })])
  })
})

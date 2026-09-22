import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import { TestChatView as ChatView, type TestChatViewProps as ChatViewProps } from './dom/chat-view-fixture'
import { useAgentConversation } from '../src/renderer/src/use-agent-conversation'
import { createMockAgentApi } from './dom/agent-api-mock'
import { fakeSubmitEvent } from './dom/form-event'
import type { AgentPromptResult } from '../src/shared/agent'

// Covers the auth_required rendering and reauth-link flow: the sign-in affordance must appear
// exactly once per auth-required event, survive unrelated status updates that arrive afterward,
// and actually invoke openAuthLink when clicked. See ChatNode.tsx's AuthPanel and
// use-agent-conversation.ts's `auth`/`auth_link` handling.

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
  addImages: vi.fn(),
  removeAttachment: vi.fn(),
  submit: vi.fn(),
  cancel: vi.fn(),
  authenticate: vi.fn(),
  submitAuthCode: vi.fn(async () => true),
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

describe('AuthPanel rendering', () => {
  test('shows the sign-in button when auth is required and a method is available', () => {
    renderChatView({
      status: 'auth_required',
      authMethods: [{ id: 'claude-ai-login', name: 'Claude Subscription', type: 'terminal' }]
    })

    expect(screen.getByRole('button', { name: 'Claude Subscription' })).toBeInTheDocument()
  })

  test('blocks the FirstMate chat with an unmistakable modal while authentication is required', () => {
    renderChatView({
      status: 'auth_required',
      authMethods: [{ id: 'claude-ai-login', name: 'Claude Subscription', type: 'terminal' }]
    })

    const dialog = screen.getByRole('dialog', { name: /sign in to claude/i })
    expect(dialog).toHaveAttribute('aria-modal', 'true')
  })

  test(
    'still shows a visible auth panel (not nothing) when auth is required but no method was reported — ' +
      'regression for the "no sign-in button at all" symptom',
    () => {
      renderChatView({ status: 'auth_required', authMethods: [] })

      expect(screen.getByText(/sign in to claude/i)).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: /claude subscription/i })).toBeNull()
    }
  )

  test('does not render the auth panel once the session is ready again', () => {
    renderChatView({
      status: 'ready',
      authMethods: [{ id: 'claude-ai-login', name: 'Claude Subscription', type: 'terminal' }]
    })

    expect(screen.queryByRole('button', { name: 'Claude Subscription' })).toBeNull()
  })

  test('renders a persistent, clickable sign-in link that calls openAuthLink', () => {
    const openAuthLink = vi.fn()
    renderChatView({
      status: 'auth_required',
      authMethods: [{ id: 'claude-ai-login', name: 'Claude Subscription', type: 'terminal' }],
      authLink: 'https://claude.ai/oauth/authorize?client_id=abc',
      openAuthLink
    })

    const linkButton = screen.getByRole('button', { name: /open the sign-in link again/i })
    act(() => linkButton.click())
    expect(openAuthLink).toHaveBeenCalledWith('https://claude.ai/oauth/authorize?client_id=abc')
  })

  test('offers a working paste-back code field while terminal authentication is waiting', async () => {
    const submitAuthCode = vi.fn(async () => true)
    renderChatView({
      status: 'starting',
      reauthenticating: true,
      authMethods: [{ id: 'claude-ai-login', name: 'Claude Subscription', type: 'terminal' }],
      authLink: 'https://claude.ai/oauth/authorize?client_id=abc',
      submitAuthCode
    })

    const input = screen.getByRole('textbox', { name: /paste.*code/i })
    fireEvent.change(input, { target: { value: 'oauth-code-from-browser' } })
    fireEvent.click(screen.getByRole('button', { name: /submit code/i }))

    await waitFor(() => expect(submitAuthCode).toHaveBeenCalledWith('oauth-code-from-browser'))
  })

  test(
    'shows the sign-in link while status is "starting" as long as reauthenticating is set — ' +
      'this is the real status during the terminal-auth subprocess, not "auth_required"',
    () => {
      renderChatView({
        status: 'starting',
        reauthenticating: true,
        authMethods: [{ id: 'claude-ai-login', name: 'Claude Subscription', type: 'terminal' }],
        authLink: 'https://claude.ai/oauth/authorize?client_id=abc'
      })

      expect(screen.getByRole('button', { name: /open the sign-in link again/i })).toBeInTheDocument()
    }
  )
})

describe('useAgentConversation auth_link state', () => {
  test(
    'a sign-in link surfaced during reauth stays put — it is not overwritten by a later, unrelated ' +
      'status message — regression for the link "disappearing far too quickly to read or click"',
    async () => {
      const { api, emit } = createMockAgentApi()
      window.agentApi = api

      const { result } = renderHook(() =>
        useAgentConversation({
          id: 'session-auth',
          provider: 'claude',
          cwd: '/project',
          enabled: true,
          onSessionId: vi.fn(),
          onPermissionMode: vi.fn(),
          onModel: vi.fn()
        })
      )

      await waitFor(() => expect(result.current.status).toBe('ready'))

      const methods = [{ id: 'claude-ai-login', name: 'Claude Subscription', type: 'terminal' as const }]
      act(() => {
        emit('session-auth', { type: 'auth', methods })
        emit('session-auth', { type: 'status', status: 'auth_required', message: 'OAuth session expired' })
      })
      await waitFor(() => expect(result.current.status).toBe('auth_required'))

      act(() => {
        emit('session-auth', {
          type: 'auth_link',
          url: 'https://claude.ai/oauth/authorize?client_id=abc'
        })
      })
      await waitFor(() => expect(result.current.authLink).toBe('https://claude.ai/oauth/authorize?client_id=abc'))

      // A later, unrelated status ping (e.g. the CLI's next stdout line) must not clear the link.
      act(() => {
        emit('session-auth', { type: 'status', status: 'auth_required', message: 'Waiting for you to sign in...' })
      })
      expect(result.current.authLink).toBe('https://claude.ai/oauth/authorize?client_id=abc')
    }
  )

  test('a fresh auth_required cycle clears any sign-in link left over from a previous one', async () => {
    const { api, emit } = createMockAgentApi()
    window.agentApi = api

    const { result } = renderHook(() =>
      useAgentConversation({
        id: 'session-auth-2',
        provider: 'claude',
        cwd: '/project',
        enabled: true,
        onSessionId: vi.fn(),
        onPermissionMode: vi.fn(),
        onModel: vi.fn()
      })
    )

    await waitFor(() => expect(result.current.status).toBe('ready'))

    const methods = [{ id: 'claude-ai-login', name: 'Claude Subscription', type: 'terminal' as const }]
    act(() => {
      emit('session-auth-2', { type: 'auth', methods })
      emit('session-auth-2', { type: 'status', status: 'auth_required' })
      emit('session-auth-2', { type: 'auth_link', url: 'https://claude.ai/oauth/authorize?stale=1' })
    })
    await waitFor(() => expect(result.current.authLink).toBe('https://claude.ai/oauth/authorize?stale=1'))

    act(() => {
      emit('session-auth-2', { type: 'auth', methods })
    })
    expect(result.current.authLink).toBeNull()
  })

  test(
    'the sign-in link is exposed during the real authenticate() call, while status is transiently ' +
      '"starting" rather than "auth_required" — regression for the link never rendering because the ' +
      'real emission path never coincides with status === "auth_required"',
    async () => {
      let resolveAuthenticate: (result: { ok: boolean; status: 'auth_required'; message?: string }) => void = () => {}
      const authenticatePromise = new Promise<{ ok: boolean; status: 'auth_required'; message?: string }>((resolve) => {
        resolveAuthenticate = resolve
      })
      const { api, emit } = createMockAgentApi({
        authenticate: vi.fn(() => authenticatePromise)
      })
      window.agentApi = api

      const { result } = renderHook(() =>
        useAgentConversation({
          id: 'session-auth-3',
          provider: 'claude',
          cwd: '/project',
          enabled: true,
          onSessionId: vi.fn(),
          onPermissionMode: vi.fn(),
          onModel: vi.fn()
        })
      )

      await waitFor(() => expect(result.current.status).toBe('ready'))

      const methods = [{ id: 'claude-ai-login', name: 'Claude Subscription', type: 'terminal' as const }]
      act(() => {
        emit('session-auth-3', { type: 'auth', methods })
        emit('session-auth-3', { type: 'status', status: 'auth_required', message: 'OAuth session expired' })
      })
      await waitFor(() => expect(result.current.status).toBe('auth_required'))

      act(() => {
        result.current.authenticate('claude-ai-login')
      })
      expect(result.current.status).toBe('starting')

      act(() => {
        emit('session-auth-3', { type: 'auth_link', url: 'https://claude.ai/oauth/authorize?client_id=abc' })
      })

      expect(result.current.authLink).toBe('https://claude.ai/oauth/authorize?client_id=abc')
      expect(result.current.reauthenticating).toBe(true)

      await act(async () => {
        resolveAuthenticate({ ok: false, status: 'auth_required', message: 'Still waiting' })
        await authenticatePromise
      })
      await waitFor(() => expect(result.current.reauthenticating).toBe(false))
    }
  )
})

describe('useAgentConversation prompt failure status', () => {
  // Regression for GitHub issue #156: when an active session's OAuth token expires, main publishes
  // `auth` + `status: "auth_required"` *before* the prompt promise settles with `{ ok: false }`.
  // The renderer must not overwrite that authoritative status with `ready`, or the sign-in panel
  // disappears and the node only shows the failure text.
  function renderConversation(
    id: string,
    api: ReturnType<typeof createMockAgentApi>['api'],
    composePrompt?: (text: string) => string | Promise<string>
  ) {
    window.agentApi = api
    return renderHook(() =>
      useAgentConversation({
        id,
        provider: 'claude',
        cwd: '/project',
        enabled: true,
        composePrompt,
        onSessionId: vi.fn(),
        onPermissionMode: vi.fn(),
        onModel: vi.fn()
      })
    )
  }

  /** A `prompt` stand-in whose turn the test ends by hand, after main's events have been emitted. */
  function controlledPrompt(): {
    prompt: () => Promise<AgentPromptResult>
    settle: (result: AgentPromptResult) => void
  } {
    let resolveTurn: (result: AgentPromptResult) => void = () => {}
    const prompt = (): Promise<AgentPromptResult> =>
      new Promise((resolve) => {
        resolveTurn = resolve
      })
    return { prompt, settle: (result) => resolveTurn(result) }
  }

  /** One macrotask, enough for the settled prompt to run through `deliverAgentPrompt`'s then-chain. */
  const nextTick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

  test('an OAuth refresh failure leaves the node in auth_required with the sign-in panel visible', async () => {
    const turn = controlledPrompt()
    const { api, emit } = createMockAgentApi({ prompt: vi.fn(turn.prompt) })
    const { result } = renderConversation('session-oauth-expired', api)
    await waitFor(() => expect(result.current.status).toBe('ready'))

    act(() => result.current.submit(fakeSubmitEvent(), 'continue please'))
    expect(result.current.status).toBe('working')
    await waitFor(() => expect(api.prompt).toHaveBeenCalledTimes(1))

    const methods = [{ id: 'claude-ai-login', name: 'Claude Subscription', type: 'terminal' as const }]
    const message = 'OAuth session expired and could not be refreshed'
    act(() => {
      emit('session-oauth-expired', { type: 'auth', methods })
      emit('session-oauth-expired', { type: 'status', status: 'auth_required', message })
    })
    await act(async () => {
      turn.settle({ ok: false, message })
      await nextTick()
    })

    expect(result.current.detail).toBe(message)
    expect(result.current.status).toBe('auth_required')

    renderChatView({ status: result.current.status, authMethods: result.current.authMethods })
    expect(screen.getByRole('dialog', { name: /sign in to claude/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Claude Subscription' })).toBeInTheDocument()
  })

  test('an ordinary provider failure returns the node to ready', async () => {
    const turn = controlledPrompt()
    const { api, emit } = createMockAgentApi({ prompt: vi.fn(turn.prompt) })
    const { result } = renderConversation('session-turn-failed', api)
    await waitFor(() => expect(result.current.status).toBe('ready'))

    act(() => result.current.submit(fakeSubmitEvent(), 'do the thing'))
    expect(result.current.status).toBe('working')
    await waitFor(() => expect(api.prompt).toHaveBeenCalledTimes(1))

    act(() => {
      emit('session-turn-failed', { type: 'turn_failed', turnId: 'turn-1', message: 'The provider rejected the turn.' })
      emit('session-turn-failed', { type: 'status', status: 'ready' })
    })
    await act(async () => {
      turn.settle({ ok: false, message: 'The provider rejected the turn.' })
      await nextTick()
    })

    expect(result.current.detail).toBe('The provider rejected the turn.')
    expect(result.current.status).toBe('ready')
  })

  test('a pre-turn refusal without any status event still returns the node to ready', async () => {
    const { api } = createMockAgentApi({
      prompt: vi.fn(async () => ({ ok: false, message: 'This agent does not support image attachments.' }))
    })
    const { result } = renderConversation('session-refused', api)
    await waitFor(() => expect(result.current.status).toBe('ready'))

    act(() => result.current.submit(fakeSubmitEvent(), 'hello'))

    await waitFor(() => expect(result.current.detail).toBe('This agent does not support image attachments.'))
    expect(result.current.status).toBe('ready')
  })

  test('a local prompt-composition failure does not leave the UI stuck in working', async () => {
    const { api } = createMockAgentApi()
    const { result } = renderConversation('session-compose-failed', api, () => {
      throw new Error('Could not read the workspace context.')
    })
    await waitFor(() => expect(result.current.status).toBe('ready'))

    act(() => result.current.submit(fakeSubmitEvent(), 'hello'))

    await waitFor(() => expect(result.current.detail).toBe('Could not read the workspace context.'))
    expect(result.current.status).toBe('ready')
    expect(api.prompt).not.toHaveBeenCalled()
  })
})

import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import { ChatView, type ChatViewProps } from '../src/renderer/src/ChatNode'
import { useAgentConversation } from '../src/renderer/src/use-agent-conversation'
import { createMockAgentApi } from './dom/agent-api-mock'

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
  setDraft: vi.fn(),
  addImages: vi.fn(),
  removeAttachment: vi.fn(),
  submit: vi.fn(),
  cancel: vi.fn(),
  authenticate: vi.fn(),
  submitAuthCode: vi.fn(async () => true),
  openAuthLink: vi.fn(),
  resolveApproval: vi.fn(),
  sendMessage: vi.fn(),
  answerDecision: vi.fn()
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
    'still shows a visible auth panel (not nothing) when auth is required but no method was reported — '
    + 'regression for the "no sign-in button at all" symptom',
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
    'shows the sign-in link while status is "starting" as long as reauthenticating is set — '
    + 'this is the real status during the terminal-auth subprocess, not "auth_required"',
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
    'a sign-in link surfaced during reauth stays put — it is not overwritten by a later, unrelated '
    + 'status message — regression for the link "disappearing far too quickly to read or click"',
    async () => {
      const { api, emit } = createMockAgentApi()
      window.agentApi = api

      const { result } = renderHook(() => useAgentConversation({
        id: 'session-auth',
        provider: 'claude',
        cwd: '/project',
        enabled: true,
        onSessionId: vi.fn(),
        onPermissionMode: vi.fn(),
        onModel: vi.fn()
      }))

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

    const { result } = renderHook(() => useAgentConversation({
      id: 'session-auth-2',
      provider: 'claude',
      cwd: '/project',
      enabled: true,
      onSessionId: vi.fn(),
      onPermissionMode: vi.fn(),
      onModel: vi.fn()
    }))

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
    'the sign-in link is exposed during the real authenticate() call, while status is transiently '
    + '"starting" rather than "auth_required" — regression for the link never rendering because the '
    + 'real emission path never coincides with status === "auth_required"',
    async () => {
      let resolveAuthenticate: (result: { ok: boolean; status: 'auth_required'; message?: string }) => void = () => {}
      const authenticatePromise = new Promise<{ ok: boolean; status: 'auth_required'; message?: string }>((resolve) => {
        resolveAuthenticate = resolve
      })
      const { api, emit } = createMockAgentApi({
        authenticate: vi.fn(() => authenticatePromise)
      })
      window.agentApi = api

      const { result } = renderHook(() => useAgentConversation({
        id: 'session-auth-3',
        provider: 'claude',
        cwd: '/project',
        enabled: true,
        onSessionId: vi.fn(),
        onPermissionMode: vi.fn(),
        onModel: vi.fn()
      }))

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

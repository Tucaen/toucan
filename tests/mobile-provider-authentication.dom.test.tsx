import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import ProviderSignIn from '../mobile/src/ProviderSignIn'
import type { SavedHost } from '../mobile/src/hosts'
import type { ProviderAuthenticationState } from '../src/shared/provider-authentication'

const HOST: SavedHost = { id: 'work', name: 'Work PC', origin: 'https://work-pc.test', token: 'paired-test-token' }
const INITIAL: ProviderAuthenticationState = {
  required: true,
  methods: [{ id: 'claude-ai-login', name: 'Claude Subscription', mode: 'code' }]
}
const WAITING: ProviderAuthenticationState = {
  ...INITIAL,
  attempt: {
    id: 'a-1',
    methodId: 'claude-ai-login',
    status: 'waiting',
    url: 'https://claude.ai/oauth/authorize?state=test-state'
  }
}
let state: ProviderAuthenticationState
let operations: Record<string, unknown>[]
let unauthorized: ReturnType<typeof vi.fn>

beforeEach(() => {
  state = INITIAL
  operations = []
  unauthorized = vi.fn()
  window.localStorage.clear()
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe('https://work-pc.test/api/chats/chat-1/authentication')
      expect(init.headers).toMatchObject({ authorization: 'Bearer paired-test-token' })
      expect(init.cache).toBe('no-store')
      if (init.body) {
        const action = JSON.parse(init.body as string) as Record<string, unknown>
        operations.push(action)
        if (action.action === 'start') state = WAITING
        if (action.action === 'code') state = { ...WAITING, attempt: { ...WAITING.attempt!, codeSubmitted: true } }
        if (action.action === 'cancel')
          state = {
            ...INITIAL,
            attempt: { id: 'a-1', methodId: 'claude-ai-login', status: 'cancelled', message: 'Sign-in cancelled.' }
          }
      }
      return new Response(JSON.stringify(state), { status: 200 })
    })
  )
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function open(needed = true, online = true) {
  return render(
    <ProviderSignIn host={HOST} chatId="chat-1" needed={needed} online={online} onUnauthorized={unauthorized} />
  )
}

test('phone starts Claude sign-in and submits a code once as a paired body, without retaining a credential', async () => {
  open()
  fireEvent.click(await screen.findByRole('button', { name: 'Sign in: Claude Subscription' }))
  const link = await screen.findByRole('link', { name: 'Open sign-in on this phone' })
  expect(link).toHaveAttribute('href', WAITING.attempt!.url)
  expect(link).toHaveAttribute('rel', 'noreferrer noopener')
  expect(link).toHaveAttribute('referrerpolicy', 'no-referrer')
  const input = screen.getByLabelText('Code shown by the provider')
  expect(input).toHaveAttribute('type', 'password')
  expect(input).toHaveAttribute('autocomplete', 'off')
  fireEvent.change(input, { target: { value: 'private-test-code' } })
  fireEvent.click(screen.getByRole('button', { name: 'Submit code' }))
  await screen.findByText('Code sent. Waiting for the provider to confirm sign-in…')
  expect(operations).toEqual([
    { action: 'start', methodId: 'claude-ai-login' },
    { action: 'code', attemptId: 'a-1', code: 'private-test-code' }
  ])
  expect(screen.queryByDisplayValue('private-test-code')).not.toBeInTheDocument()
  expect(JSON.stringify(window.localStorage)).not.toContain('private-test-code')
  expect(document.body.textContent).not.toContain('private-test-code')
  expect(screen.queryByText('Signed in')).not.toBeInTheDocument()
})

test('a rejoined phone reads the live attempt and can cancel without creating another one', async () => {
  state = WAITING
  open()
  await screen.findByRole('link', { name: 'Open sign-in on this phone' })
  expect(operations).toEqual([])
  fireEvent.click(screen.getByRole('button', { name: 'Cancel sign-in' }))
  await screen.findByText('Sign-in cancelled.')
  expect(operations).toEqual([{ action: 'cancel', attemptId: 'a-1' }])
  expect(screen.queryByRole('link')).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Sign in: Claude Subscription' })).toBeEnabled()
})

test('Codex displays the provider device code, has no paste-back form, and shows only host-confirmed success', async () => {
  vi.useFakeTimers()
  state = {
    required: true,
    methods: [{ id: 'chat-gpt-device-code', name: 'ChatGPT (device code)', mode: 'device' }],
    attempt: {
      id: 'd-1',
      methodId: 'chat-gpt-device-code',
      status: 'waiting',
      url: 'https://auth.openai.com/codex/device',
      userCode: 'TEST-1234'
    }
  }
  const view = open()
  await act(async () => {})
  expect(screen.getByText('TEST-1234')).toBeInTheDocument()
  expect(screen.queryByLabelText('Code shown by the provider')).not.toBeInTheDocument()
  expect(screen.queryByText('Signed in')).not.toBeInTheDocument()
  state = {
    required: false,
    methods: [],
    attempt: {
      id: 'd-1',
      methodId: 'chat-gpt-device-code',
      status: 'succeeded',
      message: 'Signed in. You can send your message again.'
    }
  }
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1500)
  })
  view.rerender(<ProviderSignIn host={HOST} chatId="chat-1" needed={false} online onUnauthorized={unauthorized} />)
  expect(screen.getByRole('heading', { name: 'Signed in' })).toBeInTheDocument()
  expect(screen.queryByText('TEST-1234')).not.toBeInTheDocument()
  expect(screen.queryByRole('link')).not.toBeInTheDocument()
  view.unmount()
})

test('unsupported hosts/methods and failed attempts give an honest desktop fallback or retry', async () => {
  state = { required: true, methods: [] }
  const view = open()
  await screen.findByText(/No supported phone sign-in method/)
  expect(screen.queryByRole('button', { name: /Sign in:/ })).not.toBeInTheDocument()
  view.unmount()
  state = {
    ...INITIAL,
    attempt: {
      id: 'a-1',
      methodId: 'claude-ai-login',
      status: 'failed',
      message: 'Sign-in failed or timed out. Try again.'
    }
  }
  open()
  await screen.findByText('Sign-in failed or timed out. Try again.')
  expect(screen.getByRole('button', { name: 'Sign in: Claude Subscription' })).toBeEnabled()
})

test('disconnected controls are inert and revoked pairing returns to pairing', async () => {
  const view = open()
  await screen.findByRole('button', { name: 'Sign in: Claude Subscription' })
  view.rerender(<ProviderSignIn host={HOST} chatId="chat-1" needed online={false} onUnauthorized={unauthorized} />)
  expect(screen.getByRole('button', { name: 'Sign in: Claude Subscription' })).toBeDisabled()
  expect(screen.getByText(/Reconnect to the PC/)).toBeInTheDocument()
  vi.mocked(fetch).mockResolvedValue(new Response('', { status: 401 }))
  view.rerender(<ProviderSignIn host={HOST} chatId="chat-1" needed online onUnauthorized={unauthorized} />)
  await waitFor(() => expect(unauthorized).toHaveBeenCalledTimes(1))
})

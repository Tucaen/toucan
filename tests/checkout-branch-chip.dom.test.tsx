import { act, render, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { TestChatView as ChatView, type TestChatViewProps as ChatViewProps } from './dom/chat-view-fixture'
import CheckoutBranchChip from '../src/renderer/src/CheckoutBranchChip'
import { useCheckoutBranch } from '../src/renderer/src/use-checkout-branch'
import type { GitBranchState } from '../src/shared/git-branch'

// A node's status bar names the branch of the checkout it actually runs in - the project's, or its
// worktree's - because that is the one fact about the checkout an agent can change under the
// reader without saying so.

const DIRECTORY = 'D:/Development/Toucan-worktrees/feature-login'

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
  submitAuthCode: vi.fn(),
  openAuthLink: vi.fn(),
  resolveApproval: vi.fn(),
  sendMessage: vi.fn(),
  answerDecision: vi.fn(),
  queued: [],
  editQueued: vi.fn(),
  withdrawQueued: vi.fn(),
  sendQueuedNow: vi.fn()
}

function renderChip(state: GitBranchState | null): HTMLElement | null {
  const { container } = render(
    <ChatView
      {...baseChatViewProps}
      focusMode={false}
      setFocusMode={vi.fn()}
      statusBar={<CheckoutBranchChip state={state} directory={DIRECTORY} />}
    />
  )
  return container.querySelector('.agent-chat-status-bar .session-checkout-branch')
}

function stubCurrentBranch(currentBranch: unknown): void {
  Object.defineProperty(window, 'worktreeApi', { configurable: true, value: { currentBranch } })
}

afterEach(() => {
  vi.useRealTimers()
})

describe("the checkout's branch in the chat status bar", () => {
  test('names the branch the checkout is on', () => {
    const chip = renderChip({ isRepository: true, branch: 'feature/login' })
    expect(chip?.textContent).toBe('feature/login')
    expect(chip?.getAttribute('title')).toBe(`${DIRECTORY} is on feature/login`)
    expect(chip?.getAttribute('data-detached')).toBeNull()
  })

  test('a detached HEAD never reads as a branch', () => {
    expect(renderChip({ isRepository: true, detachedHead: '9f1c2ab' })?.textContent).toBe('detached at 9f1c2ab')
    expect(renderChip({ isRepository: true })?.textContent).toBe('detached')
    expect(renderChip({ isRepository: true })?.getAttribute('data-detached')).toBe('true')
  })

  test('a directory that is not a git repository shows nothing at all', () => {
    expect(renderChip({ isRepository: false })).toBeNull()
    expect(renderChip(null)).toBeNull()
  })
})

describe('reading the branch', () => {
  test('polls, because a checkout changes from outside the app', async () => {
    vi.useFakeTimers()
    const currentBranch = vi
      .fn()
      .mockResolvedValueOnce({ isRepository: true, branch: 'main' })
      .mockResolvedValue({ isRepository: true, branch: 'feature/login' })
    stubCurrentBranch(currentBranch)

    const { result } = renderHook(() => useCheckoutBranch(DIRECTORY))
    await act(async () => {})
    expect(result.current).toEqual({ isRepository: true, branch: 'main' })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })
    expect(result.current).toEqual({ isRepository: true, branch: 'feature/login' })
    expect(currentBranch).toHaveBeenCalledWith(DIRECTORY)
  })

  test('a failed read keeps the last good answer rather than blanking the row', async () => {
    const currentBranch = vi
      .fn()
      .mockResolvedValueOnce({ isRepository: true, branch: 'main' })
      .mockRejectedValue(new Error('index.lock'))
    stubCurrentBranch(currentBranch)

    const { result } = renderHook(() => useCheckoutBranch(DIRECTORY))
    await waitFor(() => expect(result.current).toEqual({ isRepository: true, branch: 'main' }))

    vi.useFakeTimers()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })
    expect(result.current).toEqual({ isRepository: true, branch: 'main' })
  })
})

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { TestChatView as ChatView, type TestChatViewProps as ChatViewProps } from './dom/chat-view-fixture'

/*
 * The transcript's find bar (issue #171): the shared FindBar over a chat node's rendered
 * conversation. What is chat-specific and under test here is the wiring - the bar appears only
 * when the node asked for one, it searches the transcript's DOM text, and a transcript that grows
 * under an open bar (an agent still answering) is recounted via the MutationObserver-driven
 * content key rather than any prop change. The bar's own counting and navigation are covered by
 * node-find-bar.dom.test.tsx.
 */

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
  openAuthLink: vi.fn(),
  resolveApproval: vi.fn(),
  sendMessage: vi.fn(),
  answerDecision: vi.fn(),
  queued: [],
  editQueued: vi.fn(),
  withdrawQueued: vi.fn(),
  sendQueuedNow: vi.fn(),
  focusMode: false,
  setFocusMode: vi.fn()
}

function renderChatView(overrides: Partial<ChatViewProps>): {
  onClose: ReturnType<typeof vi.fn>
  rerender(next: Partial<ChatViewProps>): void
} {
  const onClose = vi.fn()
  const props: ChatViewProps = {
    ...baseChatViewProps,
    search: { open: true, openSignal: 1, label: 'Find in conversation', onClose },
    ...overrides
  }
  const { rerender } = render(<ChatView {...props} />)
  return { onClose, rerender: (next) => rerender(<ChatView {...props} {...next} />) }
}

const messages = [
  { id: '1', role: 'user' as const, text: 'where does the alpha flag live?' },
  { id: '2', role: 'assistant' as const, text: 'The alpha flag lives in config.ts beside the beta flag.' }
]

const input = (): HTMLElement => screen.getByLabelText('Find in conversation')
const count = (): string => screen.getByRole('status').textContent ?? ''

test('without a search request the transcript renders no find bar', () => {
  renderChatView({ messages, search: undefined })
  expect(screen.queryByRole('search')).toBeNull()
})

test('the find bar counts matches across user and assistant messages', () => {
  renderChatView({ messages })
  fireEvent.change(input(), { target: { value: 'alpha' } })
  expect(count()).toBe('1 of 2')
  fireEvent.keyDown(input(), { key: 'Enter' })
  expect(count()).toBe('2 of 2')
})

test('a message arriving under an open find bar is searched without any prop reaching the bar', async () => {
  const { rerender } = renderChatView({ messages })
  fireEvent.change(input(), { target: { value: 'alpha' } })
  expect(count()).toBe('1 of 2')
  rerender({
    messages: [...messages, { id: '3', role: 'assistant' as const, text: 'One more alpha, streamed late.' }]
  })
  // The recount rides on a MutationObserver, which reports after the microtask queue drains.
  await waitFor(() => expect(count()).toBe('1 of 3'))
})

test('Escape hands the close back to the node', () => {
  const { onClose } = renderChatView({ messages })
  fireEvent.keyDown(input(), { key: 'Escape' })
  expect(onClose).toHaveBeenCalledTimes(1)
})

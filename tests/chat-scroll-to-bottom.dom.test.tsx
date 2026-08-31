import { fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { TestChatView as ChatView, type TestChatViewProps as ChatViewProps } from './dom/chat-view-fixture'

// jsdom never computes real layout, so scrollHeight/clientHeight are always 0 unless a test
// fakes them. These tests patch the two accessors on HTMLElement.prototype for their duration
// so the component's scroll-follow logic sees plausible content/viewport heights, mirroring
// how a real browser would report them once messages are actually laid out.
let mockScrollHeight = 0
let mockClientHeight = 0
let originalScrollHeight: PropertyDescriptor | undefined
let originalClientHeight: PropertyDescriptor | undefined

beforeEach(() => {
  mockScrollHeight = 0
  mockClientHeight = 0
  originalScrollHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight')
  originalClientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight')
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get: () => mockScrollHeight })
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => mockClientHeight })
})

afterEach(() => {
  if (originalScrollHeight) Object.defineProperty(HTMLElement.prototype, 'scrollHeight', originalScrollHeight)
  if (originalClientHeight) Object.defineProperty(HTMLElement.prototype, 'clientHeight', originalClientHeight)
})

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

function renderChatView(overrides: Partial<ChatViewProps>): {
  scrollContainer: HTMLDivElement
  rerender(next: Partial<ChatViewProps>): void
} {
  const props = { ...baseChatViewProps, ...overrides }
  const { container, rerender } = render(<ChatView {...props} focusMode setFocusMode={vi.fn()} />)
  const scrollContainer = container.querySelector('.chat-scroll') as HTMLDivElement
  return {
    scrollContainer,
    rerender: (next) => rerender(<ChatView {...props} {...next} focusMode setFocusMode={vi.fn()} />)
  }
}

describe('chat scroll-to-bottom behavior', () => {
  test('mounting with existing message history starts scrolled to the bottom', () => {
    mockScrollHeight = 900
    mockClientHeight = 300

    const { scrollContainer } = renderChatView({
      messages: [
        { id: '1', role: 'user', text: 'hello' },
        { id: '2', role: 'assistant', text: 'hi there' }
      ]
    })

    expect(scrollContainer.scrollTop).toBe(900)
  })

  test('a new message arriving while already at the bottom keeps the view pinned to the bottom', () => {
    mockScrollHeight = 300
    mockClientHeight = 200

    const { scrollContainer, rerender } = renderChatView({
      messages: [{ id: '1', role: 'user', text: 'hello' }]
    })
    expect(scrollContainer.scrollTop).toBe(300)

    // User stays at the bottom (distance from bottom is 0, well within the threshold).
    scrollContainer.scrollTop = 100
    fireEvent.scroll(scrollContainer)

    mockScrollHeight = 600
    rerender({
      messages: [
        { id: '1', role: 'user', text: 'hello' },
        { id: '2', role: 'assistant', text: 'a reply that grows the content' }
      ]
    })

    expect(scrollContainer.scrollTop).toBe(600)
  })

  test('a new message arriving while the user scrolled up to read history does not yank them back down', () => {
    mockScrollHeight = 300
    mockClientHeight = 200

    const { scrollContainer, rerender } = renderChatView({
      messages: [{ id: '1', role: 'user', text: 'hello' }]
    })

    // User deliberately scrolls to the top, far past the auto-follow threshold.
    scrollContainer.scrollTop = 0
    fireEvent.scroll(scrollContainer)

    mockScrollHeight = 600
    rerender({
      messages: [
        { id: '1', role: 'user', text: 'hello' },
        { id: '2', role: 'assistant', text: 'a reply that arrives while scrolled up' }
      ]
    })

    expect(scrollContainer.scrollTop).toBe(0)
  })
})

// Not covered here: a real browser also reflows text when the container is resized (e.g. the
// FirstMate panel divider or node border being dragged), which can shift scrollHeight without a
// messages/approval/status change. jsdom never computes layout from CSS, so there is no reflow to
// observe and no way to exercise that path in this harness - it's exercised manually per the
// task's acceptance criteria instead.

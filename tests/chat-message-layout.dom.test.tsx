import { render, screen } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import { ChatView, type ChatViewProps } from '../src/renderer/src/ChatNode'

// Covers the removal of the redundant per-message sender label ("You" / provider name):
// the label text must not render at all, and user vs. assistant messages must remain
// visually distinguishable through layout/classes alone (role class + alignment/background),
// per ChatNode.tsx's message rendering and styles.css's `.chat-message` rules.

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
  resolveApproval: vi.fn()
}

function renderChatView(overrides: Partial<ChatViewProps>): HTMLElement {
  const { container } = render(
    <ChatView
      {...baseChatViewProps}
      {...overrides}
      worklogCollapsed
      setWorklogCollapsed={vi.fn()}
    />
  )
  return container
}

describe('chat message sender label removal', () => {
  test('does not render "You" or the provider name as a sender label', () => {
    renderChatView({
      messages: [
        { id: '1', role: 'user', text: 'hello there' },
        { id: '2', role: 'assistant', text: 'hi, how can I help' }
      ]
    })

    expect(screen.queryByText('You')).toBeNull()
    expect(screen.queryByText('Claude')).toBeNull()
  })

  test('a user message article contains only the message content div, no label element', () => {
    const container = renderChatView({
      messages: [{ id: '1', role: 'user', text: 'hello there' }]
    })

    const article = container.querySelector('article.chat-message.user') as HTMLElement
    expect(article).not.toBeNull()
    expect(article.children).toHaveLength(1)
    expect(article.querySelector('span')).toBeNull()
    expect(article.children[0].tagName).toBe('DIV')
    expect(article.textContent).toBe('hello there')
  })

  test('an assistant message article contains only the message content div, no label element', () => {
    const container = renderChatView({
      messages: [{ id: '1', role: 'assistant', text: 'hi, how can I help' }]
    })

    const article = container.querySelector('article.chat-message.assistant') as HTMLElement
    expect(article).not.toBeNull()
    expect(article.children).toHaveLength(1)
    expect(article.querySelector('span')).toBeNull()
    expect(article.children[0].tagName).toBe('DIV')
    expect(article.textContent).toBe('hi, how can I help')
  })

  test('user and assistant messages remain visually distinguishable via role class alone', () => {
    const container = renderChatView({
      messages: [
        { id: '1', role: 'user', text: 'hello there' },
        { id: '2', role: 'assistant', text: 'hi, how can I help' }
      ]
    })

    const userArticle = container.querySelector('article.chat-message.user')
    const assistantArticle = container.querySelector('article.chat-message.assistant')
    expect(userArticle).not.toBeNull()
    expect(assistantArticle).not.toBeNull()
    expect(userArticle).not.toBe(assistantArticle)
  })
})

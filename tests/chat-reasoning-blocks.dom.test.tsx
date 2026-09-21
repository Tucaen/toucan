import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, test, vi } from 'vitest'
import { TestChatView as ChatView, type TestChatViewProps as ChatViewProps } from './dom/chat-view-fixture'

const baseProps: ChatViewProps = {
  provider: 'claude',
  messages: [
    { id: 'thought-1', role: 'thought', text: 'Reading the transcript layer.' },
    { id: 'thought-2', role: 'thought', text: 'Deciding where the merge belongs.' }
  ],
  activities: [],
  plan: [],
  approval: null,
  authMethods: [],
  authLink: null,
  reauthenticating: false,
  status: 'ready',
  focusMode: false,
  setFocusMode: vi.fn(),
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
  sendQueuedNow: vi.fn()
}

describe('reasoning blocks in the transcript', () => {
  test('merges consecutive thought messages into one quantified card', () => {
    const { container } = render(<ChatView {...baseProps} />)

    const cards = container.querySelectorAll('.thought-card')
    expect(cards).toHaveLength(1)
    expect(screen.getByText('~16 tokens')).toBeTruthy()
    expect(screen.getByText('2 thoughts')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Reasoning' }))
    expect(screen.getByText('Reading the transcript layer.')).toBeTruthy()
    expect(screen.getByText('Deciding where the merge belongs.')).toBeTruthy()
  })

  test('separates reasoning that a tool call came between', () => {
    const { container } = render(
      <ChatView
        {...baseProps}
        activities={[{ id: 'tool-1', title: 'Read ChatNode.tsx', status: 'completed' }]}
        transcript={[
          { type: 'message', id: 'thought-1', role: 'thought' },
          { type: 'activity', id: 'tool-1' },
          { type: 'message', id: 'thought-2', role: 'thought' }
        ]}
      />
    )

    expect(container.querySelectorAll('.thought-card')).toHaveLength(2)
  })

  test('shows live progress on the newest block while the turn is working', () => {
    const { container, rerender } = render(<ChatView {...baseProps} status="working" />)

    const card = container.querySelector('.thought-card')!
    expect(card.getAttribute('data-streaming')).toBe('true')
    expect(screen.getByRole('button', { name: 'Thinking' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Reasoning' })).toBeNull()
    expect(screen.getByText('Deciding where the merge belongs.')).toBeTruthy()

    rerender(<ChatView {...baseProps} status="ready" />)
    expect(container.querySelector('.thought-card')!.getAttribute('data-streaming')).toBe('false')
    expect(screen.queryByText('Deciding where the merge belongs.')).toBeNull()
  })

  test('keeps a block expanded across a re-render that unmounts the card', () => {
    function Harness(): JSX.Element {
      const [focusMode, setFocusMode] = useState(false)
      return <ChatView {...baseProps} focusMode={focusMode} setFocusMode={setFocusMode} />
    }
    render(<Harness />)

    fireEvent.click(screen.getByRole('button', { name: 'Reasoning' }))
    expect(screen.getByText('Reading the transcript layer.')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Focus' }))
    expect(screen.queryByRole('button', { name: 'Reasoning' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Focus' }))

    expect(screen.getByRole('button', { name: 'Reasoning' }).getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText('Reading the transcript layer.')).toBeTruthy()
  })
})

import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, test, vi } from 'vitest'
import { ChatView, type ChatViewProps } from '../src/renderer/src/ChatNode'

const baseChatViewProps: ChatViewProps = {
  provider: 'claude',
  messages: [
    { id: 'user-1', role: 'user', text: 'Keep the dialogue readable.' },
    { id: 'thought-1', role: 'thought', text: 'Inspecting the transcript structure.' },
    { id: 'assistant-1', role: 'assistant', text: 'The dialogue stays visible.' }
  ],
  activities: [{ id: 'tool-1', title: 'Read ChatNode.tsx', status: 'completed' }],
  plan: [{ content: 'Move activity into the transcript', status: 'in_progress' }],
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

function FocusHarness(): JSX.Element {
  const [focusMode, setFocusMode] = useState(true)
  return <ChatView {...baseChatViewProps} focusMode={focusMode} setFocusMode={setFocusMode} />
}

describe('chat focus view', () => {
  test('keeps dialogue visible while hiding reversible in-progress detail', () => {
    const { container } = render(<FocusHarness />)

    expect(screen.getByText('Keep the dialogue readable.')).toBeTruthy()
    expect(screen.getByText('The dialogue stays visible.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Reasoning' })).toBeNull()
    expect(screen.queryByText('Read ChatNode.tsx')).toBeNull()
    expect(screen.queryByText('Move activity into the transcript')).toBeNull()
    expect(container.querySelector('.worklog-rail')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Focus' }))

    fireEvent.click(screen.getByRole('button', { name: 'Reasoning' }))
    expect(screen.getByText('Inspecting the transcript structure.')).toBeTruthy()
    expect(screen.getByText('Read ChatNode.tsx')).toBeTruthy()
    expect(screen.getByText('Move activity into the transcript')).toBeTruthy()
  })

  test('toggles from the keyboard shortcut', () => {
    const setFocusMode = vi.fn()
    render(<ChatView {...baseChatViewProps} focusMode={false} setFocusMode={setFocusMode} />)
    screen.getByRole('textbox').focus()

    fireEvent.keyDown(window, { key: 'f', ctrlKey: true, shiftKey: true })

    expect(setFocusMode).toHaveBeenCalledWith(true)
  })

  test('hides live progress without suppressing a later error', () => {
    const { rerender } = render(
      <ChatView
        {...baseChatViewProps}
        status="working"
        detail="Reading more files..."
        focusMode
        setFocusMode={vi.fn()}
      />
    )
    expect(screen.queryByText('Reading more files...')).toBeNull()

    rerender(
      <ChatView
        {...baseChatViewProps}
        detail="Model selection failed"
        focusMode
        setFocusMode={vi.fn()}
      />
    )
    expect(screen.getByText('Model selection failed')).toBeTruthy()
  })

  test('keeps completed progress expanded and subdued outside Focus mode', () => {
    const messages = [
      {
        id: 'progress-1',
        role: 'assistant' as const,
        presentation: 'progress' as const,
        text: 'Reading the brain-dump archive.',
        complete: true
      },
      {
        id: 'answer-1',
        role: 'assistant' as const,
        presentation: 'final' as const,
        text: 'Created 4 topics.',
        complete: true
      }
    ]
    const { rerender } = render(
      <ChatView
        {...baseChatViewProps}
        messages={messages}
        activities={[]}
        plan={[]}
        focusMode={false}
        setFocusMode={vi.fn()}
      />
    )

    const progress = screen.getByText('Reading the brain-dump archive.').closest('article')
    expect(progress).toHaveAttribute('data-presentation', 'progress')
    expect(screen.getByText('Progress')).toBeTruthy()
    expect(screen.getByText('Created 4 topics.')).toBeTruthy()

    rerender(
      <ChatView
        {...baseChatViewProps}
        messages={messages}
        activities={[]}
        plan={[]}
        focusMode
        setFocusMode={vi.fn()}
      />
    )
    expect(screen.queryByText('Reading the brain-dump archive.')).toBeNull()
    expect(screen.getByText('Created 4 topics.')).toBeTruthy()
  })

  test('keeps tool and reasoning cards in conversation order', () => {
    const { container } = render(
      <ChatView
        {...baseChatViewProps}
        focusMode={false}
        setFocusMode={vi.fn()}
        plan={[]}
        messages={[
          { id: 'user-1', role: 'user', text: 'First prompt' },
          { id: 'thought-1', role: 'thought', text: 'Then reasoning' },
          { id: 'assistant-1', role: 'assistant', text: 'Final response' }
        ]}
        activities={[{
          id: 'tool-1',
          title: 'Read between messages',
          status: 'completed'
        }]}
        transcript={[
          { type: 'message', id: 'user-1', role: 'user' },
          { type: 'activity', id: 'tool-1' },
          { type: 'message', id: 'thought-1', role: 'thought' },
          { type: 'message', id: 'assistant-1', role: 'assistant' }
        ]}
      />
    )

    const items = Array.from(container.querySelector('.chat-scroll')!.children)
      .map((element) => element.textContent)
    expect(items).toEqual([
      'First prompt',
      expect.stringContaining('Read between messages'),
      expect.stringContaining('Reasoning'),
      'Final response'
    ])
  })
})

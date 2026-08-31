import { fireEvent, render, within } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import { TestChatView as ChatView, type TestChatViewProps as ChatViewProps } from './dom/chat-view-fixture'
import { toolCardFamilies, type ToolCardFamily } from '../src/renderer/src/tool-card-families'
import type { AgentActivity } from '../src/shared/agent'

// The shared tool-card shell (issue #87): every activity renders through one chrome - header
// with icon, summary, status and duration; collapsed once complete but open while running or
// failed; a sticky per-card toggle; and a body whose size is bounded no matter how large the
// tool result is.

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

function renderCards(activities: AgentActivity[]): HTMLElement {
  const { container } = render(
    <ChatView {...baseChatViewProps} activities={activities} focusMode={false} setFocusMode={vi.fn()} />
  )
  return container
}

function card(container: HTMLElement, index = 0): HTMLElement {
  const cards = container.querySelectorAll<HTMLElement>('.activity-card')
  expect(cards.length).toBeGreaterThan(index)
  return cards[index]
}

describe('shared tool card shell', () => {
  test('the header is always present with summary, status and elapsed duration', () => {
    const container = renderCards([
      {
        id: 'run-1',
        title: 'Ran the test suite',
        kind: 'execute',
        status: 'completed',
        startedAt: 1_000,
        endedAt: 13_500
      }
    ])
    const header = within(card(container)).getByRole('button', { expanded: false })
    expect(header.textContent).toContain('Ran the test suite')
    expect(header.textContent).toContain('done')
    expect(header.textContent).toContain('12s')
  })

  test('a running call is expanded and a completed one is collapsed', () => {
    const container = renderCards([
      { id: 'a', title: 'Reading', kind: 'read', status: 'in_progress', content: 'partial output', startedAt: 0 },
      { id: 'b', title: 'Read', kind: 'read', status: 'completed', content: 'full output', startedAt: 0, endedAt: 500 }
    ])
    expect(card(container, 0).dataset.expanded).toBe('true')
    expect(within(card(container, 0)).getByText('partial output')).toBeTruthy()
    expect(card(container, 1).dataset.expanded).toBe('false')
    expect(within(card(container, 1)).queryByText('full output')).toBeNull()
  })

  test('a failed call stays expanded and is visually distinct', () => {
    const container = renderCards([
      {
        id: 'boom',
        title: 'Ran a command',
        kind: 'execute',
        status: 'failed',
        content: 'exit code 1',
        startedAt: 0,
        endedAt: 100
      }
    ])
    expect(card(container).dataset.status).toBe('failed')
    expect(card(container).dataset.expanded).toBe('true')
    expect(within(card(container)).getByText('exit code 1')).toBeTruthy()
  })

  test('clicking the header toggles the card and the choice sticks for that card alone', () => {
    const container = renderCards([
      {
        id: 'a',
        title: 'First',
        kind: 'read',
        status: 'completed',
        content: 'first output',
        startedAt: 0,
        endedAt: 10
      },
      {
        id: 'b',
        title: 'Second',
        kind: 'read',
        status: 'completed',
        content: 'second output',
        startedAt: 0,
        endedAt: 10
      }
    ])
    fireEvent.click(within(card(container, 0)).getByRole('button'))
    expect(card(container, 0).dataset.expanded).toBe('true')
    expect(within(card(container, 0)).getByText('first output')).toBeTruthy()
    expect(card(container, 1).dataset.expanded).toBe('false')

    fireEvent.click(within(card(container, 0)).getAllByRole('button')[0])
    expect(card(container, 0).dataset.expanded).toBe('false')
  })

  test('an enormous tool result is truncated behind an explicit show more', () => {
    const huge = Array.from({ length: 5000 }, (_, index) => `line ${index}`).join('\n')
    const container = renderCards([
      {
        id: 'huge',
        title: 'Ran a command',
        kind: 'execute',
        status: 'failed',
        content: huge,
        startedAt: 0,
        endedAt: 10
      }
    ])
    const output = card(container).querySelector('pre')
    expect(output?.textContent?.split('\n').length).toBe(40)
    expect(card(container).textContent).toContain('line 39')
    expect(card(container).textContent).not.toContain('line 40\n')

    const showMore = within(card(container)).getByRole('button', { name: /show 4960 more lines/i })
    fireEvent.click(showMore)
    expect(card(container).querySelector('pre')?.textContent?.split('\n').length).toBe(5000)
    expect(within(card(container)).getByRole('button', { name: /show less/i })).toBeTruthy()
  })

  test('an activity with no title still renders through the shell with a generic summary', () => {
    const container = renderCards([{ id: 'x', kind: 'search', status: 'completed', startedAt: 0, endedAt: 10 }])
    expect(card(container).dataset.family).toBe('generic')
    expect(card(container).textContent).toContain('Searched the project')
  })

  test('an activity that arrives without a status still states one in its header', () => {
    const container = renderCards([{ id: 'x', title: 'Working', startedAt: 0 }])
    expect(card(container).textContent).toContain('running')
  })

  test('a card collapsed while running re-opens itself when the call then fails', () => {
    const working: AgentActivity = {
      id: 'a',
      title: 'Ran a command',
      kind: 'execute',
      status: 'in_progress',
      content: 'so far',
      startedAt: 0
    }
    const { container, rerender } = render(
      <ChatView {...baseChatViewProps} activities={[working]} focusMode={false} setFocusMode={vi.fn()} />
    )
    fireEvent.click(within(card(container)).getByRole('button'))
    expect(card(container).dataset.expanded).toBe('false')

    rerender(
      <ChatView
        {...baseChatViewProps}
        activities={[{ ...working, status: 'failed', content: 'exit code 1', endedAt: 900 }]}
        focusMode={false}
        setFocusMode={vi.fn()}
      />
    )
    expect(card(container).dataset.expanded).toBe('true')
    expect(within(card(container)).getByText('exit code 1')).toBeTruthy()
  })

  test('a registered family supplies its own summary and body while the shell keeps the chrome', () => {
    const family: ToolCardFamily = {
      id: 'test-family',
      matches: (activity) => activity.kind === 'execute',
      icon: () => '$',
      summary: () => <span>npm test</span>,
      body: () => ({ content: <em>custom body</em>, hiddenLines: 0 })
    }
    toolCardFamilies.push(family)
    try {
      const container = renderCards([
        {
          id: 'a',
          title: 'Ran a command',
          kind: 'execute',
          status: 'failed',
          startedAt: 0,
          endedAt: 2_000
        }
      ])
      expect(card(container).dataset.family).toBe('test-family')
      expect(card(container).textContent).toContain('npm test')
      expect(within(card(container)).getByText('custom body')).toBeTruthy()
      // Chrome the family never wrote: status, duration and the collapse toggle.
      expect(card(container).textContent).toContain('failed')
      expect(card(container).textContent).toContain('2.0s')
      fireEvent.click(within(card(container)).getByRole('button', { expanded: true }))
      expect(card(container).dataset.expanded).toBe('false')
    } finally {
      toolCardFamilies.splice(toolCardFamilies.indexOf(family), 1)
    }
  })
})

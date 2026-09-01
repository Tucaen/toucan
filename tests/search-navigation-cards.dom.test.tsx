import { fireEvent, render, within } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import { TestChatView as ChatView, type TestChatViewProps as ChatViewProps } from './dom/chat-view-fixture'
import type { AgentActivity } from '../src/shared/agent'

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

function renderCard(activity: AgentActivity): HTMLElement {
  const { container } = render(
    <ChatView
      {...baseChatViewProps}
      activities={[activity]}
      workspaceRoots={['D:\\Development\\Toucan']}
      focusMode={false}
      setFocusMode={vi.fn()}
    />
  )
  const card = container.querySelector<HTMLElement>('.activity-card')
  expect(card).not.toBeNull()
  return card as HTMLElement
}

describe('search and navigation tool cards', () => {
  test('a grep across three files summarizes counts and groups its expanded matches by file', () => {
    const card = renderCard({
      id: 'grep-1',
      kind: 'search',
      toolName: 'Grep',
      status: 'completed',
      rawInput: { pattern: 'useAgentConversation', output_mode: 'content' },
      content: [
        'D:\\Development\\Toucan\\src\\renderer\\src\\ChatNode.tsx:14:useAgentConversation()',
        'D:\\Development\\Toucan\\src\\renderer\\src\\ChatNode.tsx:29:const state = useAgentConversation()',
        'D:\\Development\\Toucan\\src\\renderer\\src\\App.tsx:82:useAgentConversation()',
        'D:\\Development\\Toucan\\tests\\chat-node.test.tsx:51:useAgentConversation()'
      ].join('\n'),
      startedAt: 0,
      endedAt: 100
    })

    expect(card.dataset.family).toBe('search-navigation')
    expect(within(card).getByRole('button', { expanded: false }).textContent).toContain(
      'useAgentConversation — 4 matches in 3 files'
    )

    fireEvent.click(within(card).getByRole('button', { expanded: false }))
    const groups = card.querySelectorAll('.search-result-group')
    expect(groups).toHaveLength(3)
    expect(groups[0].textContent).toContain('src/renderer/src/ChatNode.tsx')
    expect(groups[0].textContent).toContain('14useAgentConversation()')
    expect(groups[0].textContent).toContain('29const state = useAgentConversation()')
    expect(groups[1].textContent).toContain('src/renderer/src/App.tsx')
    expect(groups[2].textContent).toContain('tests/chat-node.test.tsx')
  })

  test('a web search leads with the result host and title and identifies external content', () => {
    const card = renderCard({
      id: 'web-search-1',
      kind: 'fetch',
      toolName: 'WebSearch',
      status: 'completed',
      rawInput: { query: 'React documentation' },
      content: ['React (https://react.dev/)', 'React repository (https://github.com/facebook/react)'].join('\n'),
      startedAt: 0,
      endedAt: 100
    })

    const header = within(card).getByRole('button', { expanded: false })
    expect(header.textContent).toContain('react.dev — React')
    expect(header.textContent).toContain('2 results')
    expect(header.textContent).toContain('External source')

    fireEvent.click(header)
    expect(card.querySelectorAll('.web-result')).toHaveLength(2)
    expect(card.textContent).toContain('github.com')
  })
})

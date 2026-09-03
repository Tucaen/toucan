import { render, within } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import { TestChatView as ChatView, type TestChatViewProps as ChatViewProps } from './dom/chat-view-fixture'
import SessionUsageBar from '../src/renderer/src/SessionUsageBar'
import { describeSessionUsage, type SessionUsageInput } from '../src/renderer/src/session-usage'
import type { AgentRateLimitStatus } from '../src/shared/agent'

// Issue #99: a chat node shows what the conversation has consumed - context against the model's
// window, cost so far, and the account window closest to biting - and warns in plain text before
// the agent has to compact.

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

function renderBar(usage: SessionUsageInput | null, rateLimits: AgentRateLimitStatus | null = null): HTMLElement {
  const readout = describeSessionUsage({ usage, rateLimits, now: 0 })
  const { container } = render(
    <ChatView
      {...baseChatViewProps}
      focusMode={false}
      setFocusMode={vi.fn()}
      statusBar={readout.empty ? undefined : <SessionUsageBar readout={readout} />}
    />
  )
  return container.firstElementChild as HTMLElement
}

describe('the per-node usage bar', () => {
  test('shows the context fill, the token counts and the session cost', () => {
    const chat = renderBar({ used: 48_231, size: 200_000, cost: { amount: 1.2345, currency: 'USD' } })
    const bar = chat.querySelector('.agent-chat-status-bar') as HTMLElement
    expect(bar).not.toBeNull()

    const context = bar.querySelector('.session-usage-context') as HTMLElement
    expect(context.dataset.level).toBe('normal')
    expect(within(context).getByText('24%')).toBeTruthy()
    expect(within(context).getByText('48.2k / 200k')).toBeTruthy()
    expect((context.querySelector('.usage-window-fill') as HTMLElement).style.width).toBe('24%')

    expect(within(bar).getByText('$1.23')).toBeTruthy()
  })

  test('warns in text, not only in a tooltip, once the window is nearly full', () => {
    const chat = renderBar({ used: 156_000, size: 200_000 })
    const warning = chat.querySelector('.session-usage-warning') as HTMLElement
    expect(warning.dataset.level).toBe('warning')
    expect(warning.textContent).toMatch(/compact/i)
    expect((chat.querySelector('.session-usage-context') as HTMLElement).dataset.level).toBe('warning')
  })

  test('escalates the same warning as the window runs out', () => {
    const chat = renderBar({ used: 194_000, size: 200_000 })
    const warning = chat.querySelector('.session-usage-warning') as HTMLElement
    expect(warning.dataset.level).toBe('critical')
    expect((chat.querySelector('.session-usage-context') as HTMLElement).dataset.level).toBe('critical')
  })

  test('surfaces the account window closest to its limit alongside the context gauge', () => {
    const chat = renderBar(
      { used: 10_000, size: 200_000 },
      { fiveHour: { usedPercent: 20 }, weekly: { usedPercent: 91, resetsAt: 7_200_000 } }
    )
    const limit = chat.querySelector('.session-usage-limit') as HTMLElement
    expect(limit.dataset.level).toBe('critical')
    expect(limit.textContent).toContain('7d')
    expect(limit.textContent).toContain('91%')
    expect(limit.title).toContain('5h: 20%')
    expect(limit.title).toMatch(/7d: 91% \(reset in 2h \| \d\d:\d\d\)/)
  })

  test('marks a provider that has actually refused a request', () => {
    const chat = renderBar(null, { fiveHour: { usedPercent: 30 }, rejected: true })
    const limit = chat.querySelector('.session-usage-limit') as HTMLElement
    expect(limit.dataset.rejected).toBe('true')
    expect(limit.dataset.level).toBe('critical')
    expect(limit.title).toMatch(/limit reached/i)
  })

  test('takes no row of the node at all before anything has been reported', () => {
    const chat = renderBar(null)
    expect(chat.querySelector('.agent-chat-status-bar')).toBeNull()
    // The grid must not reserve the row either, or the transcript loses height for nothing.
    expect(chat.classList.contains('has-status-bar')).toBe(false)
  })

  test('a context report without a window size shows the count and cost, never an unfillable gauge', () => {
    const chat = renderBar({ used: 4_000, cost: { amount: 0.0004, currency: 'USD' } })
    const bar = chat.querySelector('.agent-chat-status-bar') as HTMLElement
    expect(chat.querySelector('.session-usage-context')).toBeNull()
    expect(within(bar).getByText('4.0k tokens')).toBeTruthy()
    expect(within(bar).getByText('<$0.01')).toBeTruthy()
  })

  test('an account window past its own limit is drawn full rather than as an impossible number', () => {
    const chat = renderBar(null, { fiveHour: { usedPercent: 118 } })
    const limit = chat.querySelector('.session-usage-limit') as HTMLElement
    expect(limit.textContent).toContain('100%')
    expect(limit.textContent).not.toContain('118')
  })
})

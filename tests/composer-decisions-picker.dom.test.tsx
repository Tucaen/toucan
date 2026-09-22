import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import { TestChatView as ChatView, type TestChatViewProps as ChatViewProps } from './dom/chat-view-fixture'
import {
  DecisionDelegationContext,
  type DecisionDelegationSetting
} from '../src/renderer/src/decision-delegation-context'
import type { AgentDecisionDelegation, DecisionDelegationPreference } from '../src/shared/decision-delegation'

// Issue #213: the "Decisions" picker, now behind the composer's gear rather than in the picker
// row. The trigger is always openable - opening is what re-probes for the skill - and only the On
// option closes when the skill is absent, with the reason readable in the menu rather than only
// on hover.

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
  queued: [],
  addImages: vi.fn(),
  removeAttachment: vi.fn(),
  submit: vi.fn(),
  sendMessage: vi.fn(),
  answerDecision: vi.fn(),
  editQueued: vi.fn(),
  withdrawQueued: vi.fn(),
  sendQueuedNow: vi.fn(),
  cancel: vi.fn(),
  authenticate: vi.fn(),
  submitAuthCode: vi.fn(),
  openAuthLink: vi.fn(),
  resolveApproval: vi.fn()
}

function renderComposer(
  setting: Partial<DecisionDelegationSetting> = {},
  overrides: Partial<ChatViewProps> = {}
): { container: HTMLElement; setPreference: (next: DecisionDelegationPreference) => void } {
  const setPreference = setting.setPreference ?? vi.fn()
  const value: DecisionDelegationSetting = {
    preference: { enabled: false },
    skillInstalled: true,
    refreshAvailability: vi.fn(),
    ...setting,
    setPreference
  }
  const { container } = render(
    <DecisionDelegationContext.Provider value={value}>
      <ChatView {...baseChatViewProps} {...overrides} focusMode={false} setFocusMode={vi.fn()} />
    </DecisionDelegationContext.Provider>
  )
  return { container, setPreference }
}

/** The picker lives in the gear's portalled panel, so every case opens that first. */
function openSettings(container: HTMLElement): HTMLElement {
  fireEvent.click(container.querySelector('.composer-settings-button') as HTMLElement)
  // Panels portal to <body>, so a case that renders two composers leaves both on screen; the
  // one just opened is the last.
  const panels = screen.getAllByRole('group', { name: 'More settings' })
  return panels[panels.length - 1]
}

function openDecisions(container: HTMLElement): HTMLElement {
  const picker = openSettings(container).querySelector('[data-picker="decisions"]') as HTMLElement
  fireEvent.click(within(picker).getByRole('button'))
  return screen.getByRole('listbox', { name: 'Decisions' })
}

describe('the decisions picker', () => {
  test('turning it on and off writes the workspace preference', () => {
    const { container, setPreference } = renderComposer()
    fireEvent.click(within(openDecisions(container)).getByRole('option', { name: /On/ }))
    expect(setPreference).toHaveBeenCalledWith({ enabled: true })

    const second = renderComposer({ preference: { enabled: true } })
    fireEvent.click(within(openDecisions(second.container)).getByRole('option', { name: /Off/ }))
    expect(second.setPreference).toHaveBeenCalledWith({ enabled: false })
  })

  test('opening it re-probes, so a skill installed mid-session can be noticed', () => {
    const refreshAvailability = vi.fn()
    const { container } = renderComposer({ refreshAvailability })
    openDecisions(container)
    expect(refreshAvailability).toHaveBeenCalledTimes(1)
  })

  test('a missing skill closes the On option alone and says how to get it', () => {
    const { container } = renderComposer({ skillInstalled: false })
    // The trigger still opens - that is what re-runs the probe.
    const menu = openDecisions(container)
    const on = within(menu).getByRole('option', { name: /On/ })
    expect(on).toBeDisabled()
    expect(on).toHaveTextContent(/install `typesafe@typesafe-ai`/i)
    expect(within(menu).getByRole('option', { name: /Off/ })).toBeEnabled()
  })

  test('a session that has not launched under the preference says when it applies', () => {
    const { container } = renderComposer({ preference: { enabled: true } })
    expect(openSettings(container)).toHaveTextContent('Applies when this conversation next starts or resumes')
  })

  test("a withheld policy reports main's own reason, Codex's scope included", () => {
    const decisionDelegation: AgentDecisionDelegation = {
      status: 'unavailable',
      message:
        'Decision delegation applies to Claude sessions for now, so decision-shaped subtasks stay on the main model.'
    }
    const { container } = renderComposer({ preference: { enabled: true } }, { provider: 'codex', decisionDelegation })
    expect(openSettings(container)).toHaveTextContent('applies to Claude sessions for now')
  })
})

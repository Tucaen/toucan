import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import { TestChatView as ChatView, type TestChatViewProps as ChatViewProps } from './dom/chat-view-fixture'
import type { ComposerCommandGuard } from '../src/renderer/src/ComposerSettingsMenu'

// Ticket 04: the per-node command guard switch behind the composer's gear.

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
  commandGuard?: Partial<ComposerCommandGuard>,
  overrides: Partial<ChatViewProps> = {}
): { panel: HTMLElement; onChange: (enabled: boolean) => void } {
  const onChange = commandGuard?.onChange ?? vi.fn()
  const { container } = render(
    <ChatView
      {...baseChatViewProps}
      {...overrides}
      commandGuard={commandGuard ? { enabled: true, ...commandGuard, onChange } : undefined}
      focusMode={false}
      setFocusMode={vi.fn()}
    />
  )
  fireEvent.click(container.querySelector('.composer-settings-button') as HTMLElement)
  // Panels portal to <body>, so a case that renders two composers leaves both on screen; the
  // one just opened is the last.
  const panels = screen.getAllByRole('group', { name: 'More settings' })
  return { panel: panels[panels.length - 1], onChange }
}

const guardPicker = (panel: HTMLElement): HTMLElement | null => panel.querySelector('[data-picker="commandGuard"]')

function chooseGuardOption(panel: HTMLElement, name: RegExp): void {
  fireEvent.click(within(guardPicker(panel) as HTMLElement).getByRole('button'))
  const menus = screen.getAllByRole('listbox', { name: 'Command guard' })
  fireEvent.click(within(menus[menus.length - 1]).getByRole('option', { name }))
}

describe('the command guard switch', () => {
  test('turning it off, and on again, reports the node-level choice', () => {
    const off = renderComposer({ enabled: true })
    chooseGuardOption(off.panel, /Command guard off/)
    expect(off.onChange).toHaveBeenCalledWith(false)

    const on = renderComposer({ enabled: false })
    chooseGuardOption(on.panel, /Command guard on/)
    expect(on.onChange).toHaveBeenCalledWith(true)
  })

  test('says it applies when the session starts, and that it is only requested', () => {
    const { panel } = renderComposer({ enabled: false })
    expect(panel).toHaveTextContent('Applies when this conversation next starts or resumes')
    expect(panel).toHaveTextContent('Requested, not confirmed')
  })

  test('is shown off and cannot be opened while the guard is off everywhere', () => {
    const { panel, onChange } = renderComposer({ enabled: true, globallyOff: true })
    const trigger = within(guardPicker(panel) as HTMLElement).getByRole('button')
    expect(trigger).toHaveTextContent(/off/i)
    expect(trigger).toBeDisabled()
    expect(panel).toHaveTextContent('global command guard settings')
    fireEvent.click(trigger)
    expect(screen.queryByRole('listbox', { name: 'Command guard' })).toBeNull()
    expect(onChange).not.toHaveBeenCalled()
  })

  test('is absent where the provider has no guard, or the node cannot save the choice', () => {
    expect(guardPicker(renderComposer({ enabled: true }, { provider: 'codex' }).panel)).toBeNull()
    expect(guardPicker(renderComposer(undefined).panel)).toBeNull()
  })
})

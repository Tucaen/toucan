import { fireEvent, render, screen, within } from '@testing-library/react'
import type { ReactElement } from 'react'
import { describe, expect, test, vi } from 'vitest'
import { TestChatView as ChatView, type TestChatViewProps as ChatViewProps } from './dom/chat-view-fixture'
import { ComposerSendKeyContext } from '../src/renderer/src/composer-send-key-context'
import type { AgentCommand } from '../src/shared/agent'

// The composer's slash-command completion: the list is whatever the connected session advertises
// over ACP, it is keyboard-first, and it portals out of the node so the clipping `.terminal-node`
// can't cut it off. The filtering/insertion decisions live in slash-command-completion.ts and are
// unit-tested there; this file checks the rendered composer is actually wired to them.

const commands: AgentCommand[] = [
  { name: 'review', description: 'Review the pending changes' },
  { name: 'commit', description: 'Commit staged work', input: { hint: '[message]' } },
  { name: 'compact', description: 'Compact the conversation' }
]

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
  setDraft: vi.fn(),
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

function renderChatView(overrides: Partial<ChatViewProps> = {}): HTMLElement {
  const view: ReactElement = (
    <ComposerSendKeyContext.Provider value={{ sendKey: 'enter', setSendKey: vi.fn() }}>
      <ChatView {...baseChatViewProps} commands={commands} {...overrides} focusMode={false} setFocusMode={vi.fn()} />
    </ComposerSendKeyContext.Provider>
  )
  return render(view).container
}

function composer(): HTMLTextAreaElement {
  return screen.getByPlaceholderText('Message the agent...') as HTMLTextAreaElement
}

/** Types `value` into the composer with the caret parked at its end, as real typing leaves it. */
function type(value: string): HTMLTextAreaElement {
  const textarea = composer()
  fireEvent.change(textarea, { target: { value } })
  textarea.setSelectionRange(value.length, value.length)
  fireEvent.select(textarea)
  return textarea
}

function menu(): HTMLElement {
  return screen.getByRole('listbox', { name: 'Slash commands' })
}

describe('composer slash-command completion', () => {
  test('typing a slash lists the session’s own commands with their descriptions', () => {
    renderChatView()
    type('/')

    const options = within(menu()).getAllByRole('option')
    expect(options.map((option) => option.textContent)).toEqual([
      expect.stringContaining('/review'),
      expect.stringContaining('/commit'),
      expect.stringContaining('/compact')
    ])
    expect(options[0].textContent).toContain('Review the pending changes')
  })

  test('a command that takes arguments advertises its hint', () => {
    renderChatView()
    type('/commi')

    expect(within(menu()).getByRole('option').textContent).toContain('[message]')
  })

  test('typing narrows the list', () => {
    renderChatView()
    type('/co')

    expect(
      within(menu())
        .getAllByRole('option')
        .map((option) => option.querySelector('strong')?.firstChild?.textContent)
    ).toEqual(['/commit', '/compact'])
  })

  test('an agent that advertises nothing never opens a menu', () => {
    renderChatView({ commands: [] })
    type('/')

    expect(screen.queryByRole('listbox', { name: 'Slash commands' })).toBeNull()
  })

  test('a slash welded to a word is ordinary text', () => {
    renderChatView()
    type('look in src/')

    expect(screen.queryByRole('listbox', { name: 'Slash commands' })).toBeNull()
  })

  test('a slash opening a word mid-prompt still lists commands', () => {
    renderChatView()
    type('refactored this, now run /co')

    expect(
      within(menu())
        .getAllByRole('option')
        .map((option) => option.querySelector('strong')?.firstChild?.textContent)
    ).toEqual(['/commit', '/compact'])
  })

  test('arrow keys move the selection and Enter accepts it', () => {
    renderChatView()
    const textarea = type('/co')

    fireEvent.keyDown(textarea, { key: 'ArrowDown' })
    expect(within(menu()).getAllByRole('option')[1]).toHaveAttribute('aria-selected', 'true')

    fireEvent.keyDown(textarea, { key: 'Enter' })
    expect(textarea.value).toBe('/compact')
    expect(screen.queryByRole('listbox', { name: 'Slash commands' })).toBeNull()
  })

  test('Enter on the completion never submits the prompt', () => {
    const submit = vi.fn()
    renderChatView({ submit })
    const textarea = type('/rev')

    fireEvent.keyDown(textarea, { key: 'Enter' })
    expect(submit).not.toHaveBeenCalled()
  })

  test('Tab accepts, and a command taking arguments leaves the caret ready to type them', () => {
    renderChatView()
    const textarea = type('/commi')

    fireEvent.keyDown(textarea, { key: 'Tab' })
    expect(textarea.value).toBe('/commit ')
    expect(textarea.selectionStart).toBe('/commit '.length)
  })

  test('clicking a command inserts it', () => {
    renderChatView()
    const textarea = type('/rev')

    fireEvent.click(within(menu()).getAllByRole('option')[0])
    expect(textarea.value).toBe('/review')
  })

  test('Escape dismisses the menu without clearing the draft', () => {
    renderChatView()
    const textarea = type('/rev')

    fireEvent.keyDown(textarea, { key: 'Escape' })
    expect(screen.queryByRole('listbox', { name: 'Slash commands' })).toBeNull()
    expect(textarea.value).toBe('/rev')
  })

  test('a dismissal is spent once the draft has no slash token left', () => {
    renderChatView()
    const textarea = type('/rev')

    fireEvent.keyDown(textarea, { key: 'Escape' })
    expect(screen.queryByRole('listbox', { name: 'Slash commands' })).toBeNull()

    // Clearing the composer and starting the same command again must offer the list back.
    type('')
    type('/rev')
    expect(menu()).toBeTruthy()
  })

  test('a command can be completed again after being accepted once', () => {
    renderChatView()
    const textarea = type('/rev')
    fireEvent.keyDown(textarea, { key: 'Enter' })
    expect(textarea.value).toBe('/review')

    type('')
    type('/rev')
    expect(menu()).toBeTruthy()
  })

  test('the menu stops hovering once focus leaves the composer', () => {
    renderChatView()
    const textarea = type('/rev')
    expect(menu()).toBeTruthy()

    fireEvent.blur(textarea)
    expect(screen.queryByRole('listbox', { name: 'Slash commands' })).toBeNull()
  })

  test('the menu portals out of the clipping node so it can never be cut off', () => {
    const container = renderChatView()
    type('/')

    expect(container.querySelector('[role="listbox"][aria-label="Slash commands"]')).toBeNull()
    expect(menu().parentElement).toBe(document.body)
    expect(getComputedStyle(menu()).position).toBe('fixed')
  })

  test('a command accepted mid-draft is hoisted to the front on send, so the agent expands it', () => {
    const submit = vi.fn()
    renderChatView({ submit })
    const textarea = type('refactored this, now run /rev')
    fireEvent.keyDown(textarea, { key: 'Enter' })
    expect(textarea.value).toBe('refactored this, now run /review')

    fireEvent.keyDown(textarea, { key: 'Enter' })
    expect(submit).toHaveBeenCalledWith(expect.anything(), '/review\nrefactored this, now run', expect.any(Function))
  })

  test('arguments typed after the acceptance ride with the hoisted command', () => {
    const submit = vi.fn()
    renderChatView({ submit })
    const textarea = type('refactored this, now run /rev')
    fireEvent.keyDown(textarea, { key: 'Enter' })
    // The caret leaves the token here, which is what spends the completion's own acceptance memory.
    type('refactored this, now run /review since main')

    fireEvent.keyDown(textarea, { key: 'Enter' })
    expect(submit).toHaveBeenCalledWith(
      expect.anything(),
      '/review since main\nrefactored this, now run',
      expect.any(Function)
    )
  })

  test('a draft that already opens with its command is sent untouched', () => {
    const submit = vi.fn()
    renderChatView({ submit })
    const textarea = type('/commit fix the parser')
    fireEvent.keyDown(textarea, { key: 'Escape' })
    fireEvent.keyDown(textarea, { key: 'Enter' })
    expect(submit).toHaveBeenCalledWith(expect.anything(), '/commit fix the parser', expect.any(Function))
  })

  test('a command the captain only typed about is sent as the prose it is', () => {
    const submit = vi.fn()
    renderChatView({ submit })
    const textarea = type('what does /review do?')
    fireEvent.keyDown(textarea, { key: 'Escape' })
    fireEvent.keyDown(textarea, { key: 'Enter' })
    expect(submit).toHaveBeenCalledWith(expect.anything(), 'what does /review do?', expect.any(Function))
  })

  test('an acceptance is spent on the draft it was made in, so the next prompt is prose again', () => {
    // A real send clears the composer through `onPrepared`; the acceptance goes with it.
    const submit = vi.fn((_event, _text, onPrepared?: () => void) => onPrepared?.())
    renderChatView({ submit })
    const textarea = type('/rev')
    fireEvent.keyDown(textarea, { key: 'Enter' })
    fireEvent.keyDown(textarea, { key: 'Enter' })

    type('what does /review do?')
    fireEvent.keyDown(textarea, { key: 'Escape' })
    fireEvent.keyDown(textarea, { key: 'Enter' })
    expect(submit).toHaveBeenLastCalledWith(expect.anything(), 'what does /review do?', expect.any(Function))
  })
})

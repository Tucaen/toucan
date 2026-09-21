import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { FormEvent, ReactElement } from 'react'
import { describe, expect, test, vi } from 'vitest'
import { TestChatView as ChatView, type TestChatViewProps as ChatViewProps } from './dom/chat-view-fixture'
import { ComposerSendKeyContext } from '../src/renderer/src/composer-send-key-context'
import { DictationCleanupContext } from '../src/renderer/src/dictation-cleanup-context'
import type { ComposerSendKey } from '../src/renderer/src/composer-keys'

// The composer as a prompt editor: the send-key preference, prompt history, the queued-prompt
// chips, the picker toolbar, and draft persistence. The decisions behind each of those live in
// composer-keys.ts / prompt-history.ts / prompt-outbox.ts and are unit-tested there; this file
// checks that the rendered composer is actually wired to them.

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

test('dictation cleanup offers an explicit subscription opt-in and fixed Claude model choices', () => {
  const setPreference = vi.fn()
  const { container } = render(
    <DictationCleanupContext.Provider value={{ preference: { enabled: false }, setPreference }}>
      <ChatView {...baseChatViewProps} focusMode={false} setFocusMode={vi.fn()} />
    </DictationCleanupContext.Provider>
  )
  fireEvent.click(container.querySelector('.composer-settings-button') as HTMLElement)
  fireEvent.click(screen.getByRole('button', { name: /Dictation cleanup/ }))
  expect(screen.getAllByText(/uses your Claude subscription/)).toHaveLength(2)
  fireEvent.click(screen.getByRole('option', { name: /Haiku/ }))
  expect(setPreference).toHaveBeenCalledWith({ enabled: true, claudeModelId: 'haiku' })
})

function renderChatView(
  overrides: Partial<ChatViewProps>,
  sendKey: ComposerSendKey = 'enter',
  setSendKey: (next: ComposerSendKey) => void = vi.fn()
): HTMLElement {
  const view: ReactElement = (
    <ComposerSendKeyContext.Provider value={{ sendKey, setSendKey }}>
      <ChatView {...baseChatViewProps} {...overrides} focusMode={false} setFocusMode={vi.fn()} />
    </ComposerSendKeyContext.Provider>
  )
  return render(view).container
}

/** A submit that behaves like the real one: it reports the text and runs the clear callback. */
function recordingSubmit(sent: string[]): ChatViewProps['submit'] {
  return (event: FormEvent, draftOverride?: string, onPrepared?: () => void) => {
    event.preventDefault()
    sent.push(draftOverride ?? '')
    onPrepared?.()
  }
}

function type(textarea: HTMLElement, value: string): void {
  fireEvent.change(textarea, { target: { value } })
}

describe('the send-key preference', () => {
  test('with "Enter sends", a bare Enter submits and Shift+Enter does not', () => {
    const sent: string[] = []
    renderChatView({ submit: recordingSubmit(sent) })
    const textarea = screen.getByPlaceholderText('Message the agent...')

    type(textarea, 'first prompt')
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true })
    expect(sent).toEqual([])

    fireEvent.keyDown(textarea, { key: 'Enter' })
    expect(sent).toEqual(['first prompt'])
  })

  test('with "Ctrl+Enter sends", the two are reversed', () => {
    const sent: string[] = []
    renderChatView({ submit: recordingSubmit(sent) }, 'mod-enter')
    const textarea = screen.getByPlaceholderText('Message the agent...')

    type(textarea, 'first prompt')
    fireEvent.keyDown(textarea, { key: 'Enter' })
    expect(sent).toEqual([])

    fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true })
    expect(sent).toEqual(['first prompt'])
  })

  test("the gear's panel offers the preference and writes the chosen one back", () => {
    const setSendKey = vi.fn()
    const container = renderChatView({}, 'enter', setSendKey)

    fireEvent.click(container.querySelector('.composer-settings-button') as HTMLElement)
    fireEvent.click(screen.getByRole('button', { name: /Enter sends/ }))
    fireEvent.click(screen.getByRole('option', { name: /Ctrl\+Enter sends/ }))

    expect(setSendKey).toHaveBeenCalledWith('mod-enter')
  })
})

describe('prompt history', () => {
  test('ArrowUp on an empty composer walks back through prompts sent this session', () => {
    const sent: string[] = []
    renderChatView({ submit: recordingSubmit(sent) })
    const textarea = screen.getByPlaceholderText('Message the agent...') as HTMLTextAreaElement

    type(textarea, 'older prompt')
    fireEvent.keyDown(textarea, { key: 'Enter' })
    type(textarea, 'newer prompt')
    fireEvent.keyDown(textarea, { key: 'Enter' })
    expect(textarea).toHaveValue('')

    fireEvent.keyDown(textarea, { key: 'ArrowUp' })
    expect(textarea).toHaveValue('newer prompt')
    fireEvent.keyDown(textarea, { key: 'ArrowUp' })
    expect(textarea).toHaveValue('older prompt')
    fireEvent.keyDown(textarea, { key: 'ArrowDown' })
    expect(textarea).toHaveValue('newer prompt')
  })

  test('Escape leaves history and puts the composer back the way it was', () => {
    const sent: string[] = []
    renderChatView({ submit: recordingSubmit(sent) })
    const textarea = screen.getByPlaceholderText('Message the agent...') as HTMLTextAreaElement

    type(textarea, 'already sent')
    fireEvent.keyDown(textarea, { key: 'Enter' })

    fireEvent.keyDown(textarea, { key: 'ArrowUp' })
    expect(textarea).toHaveValue('already sent')

    // The walk started from an empty composer, so that is what leaving it restores.
    fireEvent.keyDown(textarea, { key: 'Escape' })
    expect(textarea).toHaveValue('')
  })

  test('ArrowUp in a half-written draft stays an ordinary caret move', () => {
    const sent: string[] = []
    renderChatView({ submit: recordingSubmit(sent) })
    const textarea = screen.getByPlaceholderText('Message the agent...') as HTMLTextAreaElement

    type(textarea, 'already sent')
    fireEvent.keyDown(textarea, { key: 'Enter' })
    type(textarea, 'half written')

    fireEvent.keyDown(textarea, { key: 'ArrowUp' })
    expect(textarea).toHaveValue('half written')
  })
})

describe('queued follow-ups', () => {
  const queued = [
    { id: 'q1', text: 'the follow-up', images: [] },
    { id: 'q2', text: 'and another', images: [] }
  ]

  test('each queued prompt renders as a chip that can be withdrawn or pushed through now', () => {
    const withdrawQueued = vi.fn()
    const sendQueuedNow = vi.fn()
    renderChatView({ status: 'working', queued, withdrawQueued, sendQueuedNow })

    const chips = within(screen.getByRole('list', { name: 'Queued messages' })).getAllByRole('listitem')
    expect(chips).toHaveLength(2)
    expect(chips[0]).toHaveTextContent('the follow-up')

    fireEvent.click(within(chips[0]).getByRole('button', { name: 'Withdraw' }))
    expect(withdrawQueued).toHaveBeenCalledWith('q1')

    fireEvent.click(within(chips[1]).getByRole('button', { name: 'Send now' }))
    expect(sendQueuedNow).toHaveBeenCalledWith('q2')
  })

  test('a queued prompt can be rewritten in place', () => {
    const editQueued = vi.fn()
    renderChatView({ status: 'working', queued, editQueued })

    const chip = within(screen.getByRole('list', { name: 'Queued messages' })).getAllByRole('listitem')[0]
    fireEvent.click(within(chip).getByRole('button', { name: 'Edit' }))

    const editor = screen.getByLabelText('Edit queued message')
    fireEvent.change(editor, { target: { value: 'what I actually meant' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(editQueued).toHaveBeenCalledWith('q1', 'what I actually meant')
  })

  test('cancelling an edit leaves the queued prompt exactly as it was', () => {
    const editQueued = vi.fn()
    renderChatView({ status: 'working', queued, editQueued })

    const chip = within(screen.getByRole('list', { name: 'Queued messages' })).getAllByRole('listitem')[0]
    fireEvent.click(within(chip).getByRole('button', { name: 'Edit' }))
    fireEvent.change(screen.getByLabelText('Edit queued message'), { target: { value: 'never mind' } })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(editQueued).not.toHaveBeenCalled()
    expect(screen.getByRole('list', { name: 'Queued messages' })).toHaveTextContent('the follow-up')
  })

  test('no queue section renders when nothing is waiting', () => {
    renderChatView({ status: 'working' })
    expect(screen.queryByRole('list', { name: 'Queued messages' })).toBeNull()
  })

  test('an image-carrying prompt is still editable, not frozen', () => {
    const editQueued = vi.fn()
    renderChatView({
      status: 'working',
      queued: [{ id: 'q1', text: 'look at this', images: [{ id: 'i', data: 'd', mimeType: 'image/png' }] }],
      editQueued
    })

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    fireEvent.change(screen.getByLabelText('Edit queued message'), { target: { value: 'look at this instead' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(editQueued).toHaveBeenCalledWith('q1', 'look at this instead')
  })

  test('a session that can no longer take messages says so instead of leaving the queue looking pending', () => {
    renderChatView({ status: 'exited', queued })

    const section = screen.getByRole('list', { name: 'Queued messages' }).closest('.composer-queue')
    expect(section).toHaveAttribute('data-stranded')
    expect(section).toHaveTextContent(/will not be sent/)
  })
})

test('a resumed conversation can arrow back through the prompts already in its transcript', () => {
  renderChatView({
    messages: [
      { id: '1', role: 'user', text: 'asked before the restart' },
      { id: '2', role: 'assistant', text: 'answered before the restart' }
    ]
  })
  const textarea = screen.getByPlaceholderText('Message the agent...') as HTMLTextAreaElement

  fireEvent.keyDown(textarea, { key: 'ArrowUp' })
  expect(textarea).toHaveValue('asked before the restart')
})

describe('the composer toolbar', () => {
  const selectors: Partial<ChatViewProps> = {
    models: { currentModelId: 'opus', availableModels: [{ id: 'opus', name: 'Opus' }] },
    efforts: { currentEffortId: 'high', availableEfforts: [{ id: 'high', name: 'High' }] },
    modes: { currentModeId: 'ask', availableModes: [{ id: 'ask', name: 'Ask first' }] },
    selectModel: vi.fn(),
    selectEffort: vi.fn(),
    selectMode: vi.fn()
  }

  test('keeps model, effort and permissions in the row, and nothing else', () => {
    const container = renderChatView(selectors)

    const toolbar = container.querySelector('.composer-toolbar') as HTMLElement
    expect(toolbar).not.toBeNull()
    expect(toolbar.querySelectorAll('.node-picker')).toHaveLength(3)
    // Still inside the composer, not stranded in the node header.
    expect(toolbar.closest('.chat-composer')).not.toBeNull()
  })

  test('a selector the adapter has not reported simply does not take up a slot', () => {
    const container = renderChatView({})
    const toolbar = container.querySelector('.composer-toolbar') as HTMLElement
    // The three are session-bound, so an adapter reporting none leaves the row with only the gear.
    expect(toolbar.querySelectorAll('.node-picker')).toHaveLength(0)
    expect(toolbar.querySelector('.composer-settings-button')).not.toBeNull()
  })

  test('the settings that are set once live behind the gear, not in the row', () => {
    const container = renderChatView(selectors)
    expect(container.querySelector('.composer-toolbar')).not.toHaveTextContent('Cleanup')

    fireEvent.click(container.querySelector('.composer-settings-button') as HTMLElement)
    const panel = screen.getByRole('group', { name: 'More settings' })
    // Routine-work delegation (issue #179), decisions (#213), dictation cleanup (#215), send key.
    expect(panel.querySelectorAll('.node-picker')).toHaveLength(4)
  })

  test('the provider is identity, so it reads in the node header rather than the picker row', () => {
    const container = renderChatView(selectors)
    expect(container.querySelector('.composer-toolbar')).not.toHaveTextContent('Claude')
  })
})

test('the composer publishes its draft upward so it can outlive the node', async () => {
  const onDraftChange = vi.fn()
  renderChatView({ onDraftChange })

  type(screen.getByPlaceholderText('Message the agent...'), 'a draft worth keeping')

  await waitFor(() => expect(onDraftChange).toHaveBeenCalledWith('a draft worth keeping'))
})

test('a persisted draft is what the composer comes back with', () => {
  renderChatView({ draft: 'left half-written yesterday' })
  expect(screen.getByPlaceholderText('Message the agent...')).toHaveValue('left half-written yesterday')
})

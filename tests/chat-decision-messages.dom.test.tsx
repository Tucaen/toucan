import { act, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import { TestChatView as ChatView, type TestChatViewProps as ChatViewProps } from './dom/chat-view-fixture'
import { useAgentConversation } from '../src/renderer/src/use-agent-conversation'
import { createMockAgentApi } from './dom/agent-api-mock'

// Covers the captain-facing part of decision messages: a decision-shaped assistant message gets
// distinct ("decision") styling and clickable option buttons, a routine/noise message gets muted
// ("noise") styling, an ordinary reply gets neither, and clicking an option (or submitting the
// "Other" field) sends that text through the normal submit path. See decision-message.ts for the
// classification heuristic and ChatNode.tsx's ChatMessageCard/DecisionOptions for the rendering.

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

function renderChatView(overrides: Partial<ChatViewProps>): void {
  render(<ChatView {...baseChatViewProps} {...overrides} focusMode={false} setFocusMode={vi.fn()} />)
}

const decisionText = [
  'The lint gate failed on an unused import. I can:',
  '',
  '- **Fix it now**: remove the unused import and rerun the gate',
  '- **Skip it**: leave the file as-is and move on',
  '',
  'Which would you like?'
].join('\n')

const noiseText = 'Spawning worker for task fm-142 in the alpha project.'

const normalText = 'Here is a summary of what changed: the auth middleware now checks token expiry before refresh.'

const explanatoryQuestionText = [
  '**Empfehlung: ein vertikaler Slice**',
  '',
  '1. **Container:** Zeilenklick öffnet die Detail-Komponente.',
  '2. **BAS:** Neuer Request mit vier Sub-DTOs.',
  '3. **NEXT:** Vier Karten read-only rendern.',
  '',
  '**Legacy-Ballast, der jetzt schon entscheidbar ist**',
  '',
  'Die bestehenden Options-Spalten sind ein Workaround, keine auswählbaren Alternativen.',
  '',
  'Zwei Entscheidungen brauche ich von dir:',
  '',
  '1. **Read-only zuerst?** Der Screenshot ist Change mode mit CRUD. Ich würde read-only zuerst schicken.',
  '2. **Ersetzt der Zeilenklick den VP Cockpit-Button oder bleibt der Sprung auf den Baum-Tab daneben stehen?**'
].join('\n')

const ticketReviewText = [
  'Here is the proposed breakdown:',
  '',
  '1. **Persist draft metadata**',
  '   Blocked by: None',
  '   What it delivers: Drafts survive a restart.',
  '2. **Restore drafts in the composer**',
  '   Blocked by: Persist draft metadata',
  '   What it delivers: A reopened node shows its draft.',
  '',
  'Before I publish these:',
  '',
  'Does this proposal look good?'
].join('\n')

describe('assistant message tone rendering', () => {
  test('a decision-shaped message gets decision styling and clickable options', () => {
    renderChatView({ messages: [{ id: 'm1', role: 'assistant', text: decisionText }] })

    const article = screen.getAllByText(/Which would you like/)[0]?.closest('article')
    expect(article).toHaveAttribute('data-tone', 'decision')
    expect(screen.getByRole('button', { name: /Fix it now/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Skip it/ })).toBeInTheDocument()
    expect(screen.getByPlaceholderText('Other…')).toBeInTheDocument()
    expect(screen.queryByPlaceholderText('Message the agent…')).not.toBeInTheDocument()
  })

  test('a routine/noise message gets muted styling and no option buttons', () => {
    renderChatView({ messages: [{ id: 'm2', role: 'assistant', text: noiseText }] })

    const article = screen.getByText(noiseText).closest('article')
    expect(article).toHaveAttribute('data-tone', 'noise')
    expect(article?.querySelector('.decision-options')).toBeNull()
  })

  test('a normal conversational reply gets neither decision nor noise treatment', () => {
    renderChatView({ messages: [{ id: 'm3', role: 'assistant', text: normalText }] })

    const article = screen.getByText(normalText).closest('article')
    expect(article).toHaveAttribute('data-tone', 'normal')
    expect(article?.querySelector('.decision-options')).toBeNull()
  })

  test('explanatory headings and implementation steps do not render as clickable answers', () => {
    renderChatView({ messages: [{ id: 'm-explanation', role: 'assistant', text: explanatoryQuestionText }] })

    const article = screen.getByText(/Zwei Entscheidungen brauche ich/).closest('article')
    expect(article).toHaveAttribute('data-tone', 'normal')
    expect(screen.queryByRole('region', { name: 'Pending decisions' })).not.toBeInTheDocument()
    expect(article?.querySelector('.decision-options')).toBeNull()
  })

  test('a ticket review with one confirmation keeps proposals as content and offers Agree plus Other', () => {
    renderChatView({ messages: [{ id: 'm-ticket-review', role: 'assistant', text: ticketReviewText }] })

    const article = screen.getByText('Persist draft metadata').closest('article')
    expect(article).toHaveAttribute('data-tone', 'decision')
    expect(screen.getByRole('button', { name: 'Agree' })).toBeInTheDocument()
    expect(screen.getByPlaceholderText('Other…')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Persist draft metadata/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Restore drafts in the composer/ })).not.toBeInTheDocument()
  })

  test('structured questions use tabs, retain answers, and replace the normal composer', () => {
    const resolveElicitation = vi.fn()
    renderChatView({
      decisionRequest: {
        id: 'request-1',
        message: 'Please answer the following questions.',
        questions: [
          {
            id: 'question_0',
            title: 'Scope',
            question: 'Read-only zuerst?',
            input: 'select',
            multiSelect: false,
            customAnswerId: 'question_0_custom',
            options: [
              { value: 'read-only', label: 'Read-only', description: 'Recommended' },
              { value: 'crud', label: 'Complete CRUD' }
            ]
          },
          {
            id: 'question_1',
            title: 'Navigation',
            question: 'What should the row click replace?',
            input: 'select',
            multiSelect: false,
            options: [
              { value: 'replace', label: 'Replace VP Cockpit' },
              { value: 'keep', label: 'Keep both' }
            ]
          }
        ]
      },
      resolveElicitation
    })

    const panel = screen.getByRole('region', { name: 'Decision questions' })
    expect(screen.queryByPlaceholderText('Message the agent…')).not.toBeInTheDocument()
    fireEvent.click(within(panel).getByRole('button', { name: /Read-only/ }))
    expect(within(panel).getByText('What should the row click replace?')).toBeInTheDocument()
    fireEvent.click(within(panel).getByRole('button', { name: 'Keep both' }))
    fireEvent.click(within(panel).getByRole('button', { name: 'Submit answers' }))

    expect(resolveElicitation).toHaveBeenCalledWith('request-1', {
      question_0: 'read-only',
      question_1: 'keep'
    })
  })

  test('an Other answer advances without submitting and leaves the next question answerable', () => {
    const resolveElicitation = vi.fn()
    renderChatView({
      decisionRequest: {
        id: 'request-other',
        message: 'Choose both settings.',
        questions: [
          {
            id: 'editor',
            question: 'Which editor?',
            input: 'select',
            multiSelect: false,
            customAnswerId: 'editor_custom',
            options: [{ value: 'vscode', label: 'VS Code' }]
          },
          {
            id: 'theme',
            question: 'Which theme?',
            input: 'select',
            multiSelect: false,
            options: [{ value: 'dark', label: 'Dark' }]
          }
        ]
      },
      resolveElicitation
    })

    const panel = screen.getByRole('region', { name: 'Decision questions' })
    fireEvent.change(within(panel).getByRole('textbox', { name: 'Other answer' }), {
      target: { value: 'Zed' }
    })

    expect(within(panel).queryByRole('button', { name: 'Submit answers' })).not.toBeInTheDocument()
    fireEvent.click(within(panel).getByRole('button', { name: 'Next question' }))

    expect(resolveElicitation).not.toHaveBeenCalled()
    expect(within(panel).getByText('Which theme?')).toBeInTheDocument()
    fireEvent.click(within(panel).getByRole('button', { name: 'Dark' }))
    fireEvent.click(within(panel).getByRole('button', { name: 'Submit answers' }))

    expect(resolveElicitation).toHaveBeenCalledTimes(1)
    expect(resolveElicitation).toHaveBeenCalledWith('request-other', {
      editor_custom: 'Zed',
      theme: 'dark'
    })

    fireEvent.click(within(panel).getByRole('tab', { name: /Question 1/ }))
    expect(within(panel).getByRole('textbox', { name: 'Other answer' })).toHaveValue('Zed')
  })

  test('switching between Other and a listed option keeps only the current answer mode', () => {
    const resolveElicitation = vi.fn()
    renderChatView({
      decisionRequest: {
        id: 'request-other-switch',
        message: 'Choose an editor and theme.',
        questions: [
          {
            id: 'editor',
            question: 'Which editor?',
            input: 'select',
            multiSelect: false,
            customAnswerId: 'editor_custom',
            options: [{ value: 'vscode', label: 'VS Code' }]
          },
          {
            id: 'theme',
            question: 'Which theme?',
            input: 'select',
            multiSelect: false,
            options: [{ value: 'dark', label: 'Dark' }]
          }
        ]
      },
      resolveElicitation
    })

    const panel = screen.getByRole('region', { name: 'Decision questions' })
    const other = within(panel).getByRole('textbox', { name: 'Other answer' })
    fireEvent.change(other, { target: { value: 'Zed' } })
    fireEvent.click(within(panel).getByRole('button', { name: 'VS Code' }))
    fireEvent.click(within(panel).getByRole('tab', { name: /Question 1/ }))
    expect(within(panel).getByRole('textbox', { name: 'Other answer' })).toHaveValue('')

    fireEvent.change(within(panel).getByRole('textbox', { name: 'Other answer' }), {
      target: { value: 'Sublime Text' }
    })
    expect(within(panel).getByRole('button', { name: 'VS Code' })).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(within(panel).getByRole('tab', { name: /Question 2/ }))
    fireEvent.click(within(panel).getByRole('button', { name: 'Dark' }))
    fireEvent.click(within(panel).getByRole('button', { name: 'Submit answers' }))

    expect(resolveElicitation).toHaveBeenCalledWith('request-other-switch', {
      editor_custom: 'Sublime Text',
      theme: 'dark'
    })
  })

  test('structured questions allow a partial response without cancelling the entire request', () => {
    const resolveElicitation = vi.fn()
    renderChatView({
      decisionRequest: {
        id: 'request-partial',
        message: 'Two optional questions',
        questions: [
          {
            id: 'first',
            question: 'First?',
            input: 'select',
            multiSelect: false,
            options: [{ value: 'yes', label: 'Yes' }]
          },
          {
            id: 'second',
            question: 'Second?',
            input: 'select',
            multiSelect: false,
            options: [{ value: 'later', label: 'Later' }]
          }
        ]
      },
      resolveElicitation
    })

    fireEvent.click(screen.getByRole('button', { name: 'Yes' }))
    fireEvent.click(screen.getByRole('button', { name: 'Submit answers' }))

    expect(resolveElicitation).toHaveBeenCalledWith('request-partial', { first: 'yes' })
  })

  test('structured questions expose context, progress, answer state, and keyboard-accessible navigation', () => {
    renderChatView({
      decisionRequest: {
        id: 'request-navigation',
        message: 'Choose how the migration should proceed.',
        questions: [
          {
            id: 'strategy',
            title: 'Migration strategy',
            question: 'Which rollout should we use?',
            input: 'select',
            multiSelect: false,
            options: [{ value: 'gradual', label: 'Gradual', description: 'Roll out in stages' }]
          },
          {
            id: 'note',
            title: 'Release note',
            question: 'What should users know?',
            input: 'text',
            multiSelect: false,
            options: []
          }
        ]
      },
      resolveElicitation: vi.fn()
    })

    const panel = screen.getByRole('region', { name: 'Decision questions' })
    expect(within(panel).getByText('Choose how the migration should proceed.')).toBeInTheDocument()
    expect(within(panel).getByText('Question 1 of 2')).toBeInTheDocument()

    const firstTab = within(panel).getByRole('tab', { name: /Question 1: Migration strategy/ })
    const secondTab = within(panel).getByRole('tab', { name: /Question 2: Release note/ })
    expect(firstTab).toHaveAttribute('aria-selected', 'true')
    expect(firstTab).toHaveAttribute('tabindex', '0')
    expect(secondTab).toHaveAttribute('tabindex', '-1')
    expect(firstTab).toHaveAttribute('data-answered', 'false')

    fireEvent.keyDown(firstTab, { key: 'ArrowRight' })
    expect(secondTab).toHaveFocus()
    expect(secondTab).toHaveAttribute('aria-selected', 'true')
    expect(within(panel).getByRole('tabpanel')).toHaveAttribute('aria-labelledby', secondTab.id)
    fireEvent.keyDown(secondTab, { key: 'ArrowLeft' })
    expect(firstTab).toHaveFocus()

    fireEvent.click(within(panel).getByRole('button', { name: /Gradual.*Roll out in stages/ }))
    expect(firstTab).toHaveAttribute('data-answered', 'true')
    expect(secondTab).toHaveAttribute('aria-selected', 'true')
    expect(secondTab).toHaveFocus()
    expect(within(panel).getByRole('textbox', { name: 'What should users know?' })).toBeInTheDocument()
    expect(within(panel).getByRole('tabpanel')).toHaveAttribute('data-scroll-region', 'question')
    expect(within(panel).getByRole('navigation', { name: 'Question navigation' })).toBeInTheDocument()
    expect(panel.querySelector('footer')).toContainElement(
      within(panel).getByRole('button', { name: 'Submit answers' })
    )

    fireEvent.click(within(panel).getByRole('button', { name: 'Previous question' }))
    expect(firstTab).toHaveAttribute('aria-selected', 'true')
    firstTab.focus()
    expect(firstTab).toHaveFocus()
  })

  test('required questions expose validation and keep submission disabled until answered', () => {
    renderChatView({
      decisionRequest: {
        id: 'request-required',
        message: 'Release approval',
        questions: [
          {
            id: 'approval',
            question: 'Approve this release?',
            input: 'boolean',
            multiSelect: false,
            required: true,
            options: []
          }
        ]
      },
      resolveElicitation: vi.fn()
    })

    const panel = screen.getByRole('region', { name: 'Decision questions' })
    expect(within(panel).getByText('Required')).toBeInTheDocument()
    const submit = within(panel).getByRole('button', { name: 'Submit answers' })
    expect(submit).toBeDisabled()
    expect(within(panel).getByRole('status')).toHaveTextContent('1 required answer remaining')

    fireEvent.click(within(panel).getByRole('button', { name: 'Yes' }))
    expect(submit).toBeEnabled()
    expect(within(panel).getByRole('status')).toHaveTextContent('Ready to submit')
  })

  test('final submission resolves the structured request exactly once', () => {
    const resolveElicitation = vi.fn()
    renderChatView({
      decisionRequest: {
        id: 'request-once',
        message: 'Confirm once.',
        questions: [
          {
            id: 'confirmation',
            question: 'Proceed?',
            input: 'boolean',
            multiSelect: false,
            options: []
          }
        ]
      },
      resolveElicitation
    })

    fireEvent.click(screen.getByRole('button', { name: 'Yes' }))
    const submit = screen.getByRole('button', { name: 'Submit answers' })
    fireEvent.click(submit)
    fireEvent.click(submit)

    expect(resolveElicitation).toHaveBeenCalledTimes(1)
    expect(submit).toBeDisabled()
  })

  test('a queued request gets fresh submission controls after the previous request resolves', () => {
    const resolveElicitation = vi.fn()
    const request = (id: string, question: string) => ({
      id,
      message: question,
      questions: [{ id: `${id}-answer`, question, input: 'boolean' as const, multiSelect: false, options: [] }]
    })
    const view = render(
      <ChatView
        {...baseChatViewProps}
        focusMode={false}
        setFocusMode={vi.fn()}
        decisionRequest={request('first-request', 'First?')}
        resolveElicitation={resolveElicitation}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Yes' }))
    fireEvent.click(screen.getByRole('button', { name: 'Submit answers' }))
    view.rerender(
      <ChatView
        {...baseChatViewProps}
        focusMode={false}
        setFocusMode={vi.fn()}
        decisionRequest={request('second-request', 'Second?')}
        resolveElicitation={resolveElicitation}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'No' }))
    fireEvent.click(screen.getByRole('button', { name: 'Submit answers' }))

    expect(resolveElicitation).toHaveBeenNthCalledWith(1, 'first-request', { 'first-request-answer': true })
    expect(resolveElicitation).toHaveBeenNthCalledWith(2, 'second-request', { 'second-request-answer': false })
  })

  test('answers of every supported form shape can be revisited and edited before submission', () => {
    const resolveElicitation = vi.fn()
    renderChatView({
      decisionRequest: {
        id: 'request-editing',
        message: 'Configure the run.',
        questions: [
          {
            id: 'runner',
            question: 'Which runner?',
            input: 'select',
            multiSelect: false,
            options: [
              { value: 'local', label: 'Local' },
              { value: 'remote', label: 'Remote' }
            ]
          },
          {
            id: 'checks',
            question: 'Which checks?',
            input: 'select',
            multiSelect: true,
            options: [
              { value: 'lint', label: 'Lint' },
              { value: 'test', label: 'Test' }
            ]
          },
          {
            id: 'retries',
            question: 'How many retries?',
            input: 'number',
            multiSelect: false,
            options: []
          },
          {
            id: 'format',
            question: 'Which output format?',
            input: 'select',
            multiSelect: false,
            customAnswerId: 'format_custom',
            options: []
          },
          {
            id: 'enabled',
            question: 'Enable it?',
            input: 'boolean',
            multiSelect: false,
            options: []
          }
        ]
      },
      resolveElicitation
    })

    const panel = screen.getByRole('region', { name: 'Decision questions' })
    fireEvent.click(within(panel).getByRole('button', { name: 'Local' }))
    fireEvent.click(within(panel).getByRole('button', { name: 'Lint' }))
    fireEvent.click(within(panel).getByRole('button', { name: 'Test' }))
    fireEvent.click(within(panel).getByRole('button', { name: 'Next question' }))
    fireEvent.change(within(panel).getByRole('spinbutton', { name: 'How many retries?' }), {
      target: { value: '2' }
    })
    fireEvent.click(within(panel).getByRole('button', { name: 'Next question' }))
    fireEvent.change(within(panel).getByRole('textbox', { name: 'Other answer' }), {
      target: { value: 'JSON Lines' }
    })
    fireEvent.click(within(panel).getByRole('button', { name: 'Next question' }))
    fireEvent.click(within(panel).getByRole('button', { name: 'Yes' }))

    fireEvent.click(within(panel).getByRole('tab', { name: /Question 1/ }))
    fireEvent.click(within(panel).getByRole('button', { name: 'Remote' }))
    fireEvent.click(within(panel).getByRole('tab', { name: /Question 2/ }))
    fireEvent.click(within(panel).getByRole('button', { name: 'Lint' }))
    fireEvent.click(within(panel).getByRole('tab', { name: /Question 3/ }))
    fireEvent.change(within(panel).getByRole('spinbutton', { name: 'How many retries?' }), {
      target: { value: '4' }
    })
    fireEvent.click(within(panel).getByRole('tab', { name: /Question 4/ }))
    fireEvent.change(within(panel).getByRole('textbox', { name: 'Other answer' }), {
      target: { value: 'NDJSON' }
    })
    fireEvent.click(within(panel).getByRole('tab', { name: /Question 5/ }))
    fireEvent.click(within(panel).getByRole('button', { name: 'Submit answers' }))

    expect(resolveElicitation).toHaveBeenCalledWith('request-editing', {
      runner: 'remote',
      checks: ['test'],
      retries: 4,
      format_custom: 'NDJSON',
      enabled: true
    })
  })

  test('user messages never get a decision/noise tone even if the text happens to match the shape', () => {
    renderChatView({ messages: [{ id: 'm4', role: 'user', text: decisionText }] })

    const article = screen.getByText(/Which would you like/).closest('article')
    expect(article).toHaveAttribute('data-tone', 'normal')
    expect(article?.querySelector('.decision-options')).toBeNull()
  })
})

describe('decision option interaction', () => {
  test('queues concurrent structured requests and reveals the next after resolving the first', async () => {
    const { api, emit } = createMockAgentApi()
    window.agentApi = api
    const { result } = renderHook(() =>
      useAgentConversation({
        id: 'session-structured-queue',
        provider: 'codex',
        cwd: '/project',
        enabled: true,
        onSessionId: vi.fn(),
        onPermissionMode: vi.fn(),
        onModel: vi.fn()
      })
    )
    await waitFor(() => expect(result.current.status).toBe('ready'))
    const request = (id: string, question: string) => ({
      id,
      message: question,
      questions: [{ id: `${id}-field`, question, input: 'text' as const, multiSelect: false, options: [] }]
    })

    act(() => {
      emit('session-structured-queue', { type: 'decision_request', request: request('first', 'First?') })
      emit('session-structured-queue', { type: 'decision_request', request: request('second', 'Second?') })
    })
    expect(result.current.decisionRequest?.id).toBe('first')

    act(() => result.current.resolveElicitation('first', { 'first-field': 'answer' }))
    expect(result.current.decisionRequest?.id).toBe('second')
  })

  test("clicking an option calls sendMessage with that option's text", () => {
    const answerDecision = vi.fn()
    renderChatView({
      messages: [{ id: 'm5', role: 'assistant', text: decisionText }],
      answerDecision
    })

    fireEvent.click(screen.getByRole('button', { name: /Fix it now/ }))

    expect(answerDecision).toHaveBeenCalledWith(
      expect.stringMatching(/^text:/),
      'Fix it now: remove the unused import and rerun the gate'
    )
  })

  test('submitting the "Other" field sends the typed free text', () => {
    const answerDecision = vi.fn()
    renderChatView({
      messages: [{ id: 'm6', role: 'assistant', text: decisionText }],
      answerDecision
    })

    const input = screen.getByPlaceholderText('Other…')
    fireEvent.change(input, { target: { value: 'Do something else entirely' } })
    const otherForm = within(input.closest('form')!)
    const sendButton = otherForm.getByRole('button', { name: 'Send' })
    expect(sendButton).toBeEnabled()
    fireEvent.click(sendButton)

    expect(answerDecision).toHaveBeenCalledWith(expect.stringMatching(/^text:/), 'Do something else entirely')
  })

  test('option buttons and the "Other" field are disabled when the session cannot accept messages', () => {
    const answerDecision = vi.fn()
    renderChatView({
      messages: [{ id: 'm7', role: 'assistant', text: decisionText }],
      answerDecision,
      status: 'exited'
    })

    const optionButton = screen.getByRole('button', { name: /Fix it now/ })
    expect(optionButton).toBeDisabled()
    fireEvent.click(optionButton)
    expect(answerDecision).not.toHaveBeenCalled()

    const input = screen.getByPlaceholderText('Other…')
    expect(input).toBeDisabled()
    const otherForm = within(input.closest('form')!)
    expect(otherForm.getByRole('button', { name: 'Send' })).toBeDisabled()
  })

  test('an option click sends through the same path as typing and submitting into the composer', async () => {
    const { api, emit } = createMockAgentApi()
    window.agentApi = api

    const { result } = renderHook(() =>
      useAgentConversation({
        id: 'session-decision',
        provider: 'claude',
        cwd: '/project',
        enabled: true,
        onSessionId: vi.fn(),
        onPermissionMode: vi.fn(),
        onModel: vi.fn()
      })
    )

    await waitFor(() => expect(result.current.status).toBe('ready'))

    act(() => {
      result.current.sendMessage('Fix it now: remove the unused import and rerun the gate')
    })

    await waitFor(() =>
      expect(api.prompt).toHaveBeenCalledWith(
        'session-decision',
        'Fix it now: remove the unused import and rerun the gate'
      )
    )
    await waitFor(() =>
      expect(result.current.messages).toEqual([
        {
          id: expect.any(String),
          role: 'user',
          text: 'Fix it now: remove the unused import and rerun the gate',
          queued: false
        }
      ])
    )
    // sendMessage never touches the draft, unlike submit()'s clear-on-send behavior.
    expect(result.current.draft).toBe('')

    emit('session-decision', {
      type: 'message',
      role: 'user',
      messageId: 'echo-decision',
      text: 'Fix it now: remove the unused import and rerun the gate'
    })
  })

  test.each(['claude', 'codex'] as const)('keeps %s decision controls pinned outside the transcript', (provider) => {
    renderChatView({ provider, messages: [{ id: `${provider}-decision`, role: 'assistant', text: decisionText }] })
    const pin = screen.getByRole('region', { name: 'Pending decisions' })
    expect(pin).toBeInTheDocument()
    expect(pin.closest('.chat-scroll')).toBeNull()
    expect(within(pin).getByPlaceholderText('Other…')).toBeEnabled()
  })

  test('a decision answer is submitting until accepted and a rejected answer becomes actionable again', async () => {
    let settle: ((result: { ok: boolean; message?: string }) => void) | undefined
    const prompt = vi.fn(
      () =>
        new Promise<{ ok: boolean; message?: string }>((resolve) => {
          settle = resolve
        })
    )
    const { api, emit } = createMockAgentApi({ prompt })
    window.agentApi = api
    const { result } = renderHook(() =>
      useAgentConversation({
        id: 'session-pending-decision',
        provider: 'codex',
        cwd: '/project',
        enabled: true,
        onSessionId: vi.fn(),
        onPermissionMode: vi.fn(),
        onModel: vi.fn()
      })
    )
    await waitFor(() => expect(result.current.status).toBe('ready'))

    act(() => result.current.answerDecision('beta:rollout', 'Gradual'))
    await waitFor(() =>
      expect(result.current.messages[0]).toMatchObject({
        decisionReplyTo: 'beta:rollout',
        deliveryPending: true,
        queued: false
      })
    )
    act(() => settle?.({ ok: false, message: 'Captain transport rejected the answer' }))
    await waitFor(() =>
      expect(result.current.messages[0]).toMatchObject({
        decisionReplyTo: 'beta:rollout',
        deliveryPending: false,
        failed: true,
        queued: false
      })
    )

    emit('session-pending-decision', { type: 'status', status: 'working' })
    expect(result.current.detail).toBe('Captain transport rejected the answer')
  })

  test('answering while Working uses the normal steering queue exactly once', async () => {
    const { api, emit } = createMockAgentApi()
    window.agentApi = api
    const { result } = renderHook(() =>
      useAgentConversation({
        id: 'session-working-decision',
        provider: 'claude',
        cwd: '/project',
        enabled: true,
        onSessionId: vi.fn(),
        onPermissionMode: vi.fn(),
        onModel: vi.fn()
      })
    )
    await waitFor(() => expect(result.current.status).toBe('ready'))
    act(() => emit('session-working-decision', { type: 'status', status: 'working' }))
    act(() => result.current.answerDecision('alpha:storage', 'SQLite'))
    await waitFor(() => expect(api.promptWhenIdle).toHaveBeenCalledWith('session-working-decision', 'SQLite'))
    expect(api.prompt).not.toHaveBeenCalled()
    expect(api.promptWhenIdle).toHaveBeenCalledTimes(1)
  })

  test.each(['claude', 'codex'] as const)(
    '%s streamed assistant chunks finalize only at turn completion',
    async (provider) => {
      const { api, emit } = createMockAgentApi()
      window.agentApi = api
      const id = `session-stream-${provider}`
      const { result } = renderHook(() =>
        useAgentConversation({
          id,
          provider,
          cwd: '/project',
          enabled: true,
          onSessionId: vi.fn(),
          onPermissionMode: vi.fn(),
          onModel: vi.fn()
        })
      )
      await waitFor(() => expect(result.current.status).toBe('ready'))
      act(() => {
        emit(id, {
          type: 'message',
          role: 'assistant',
          messageId: `${provider}-real-message-id`,
          text: decisionText.slice(0, 35)
        })
        emit(id, {
          type: 'message',
          role: 'assistant',
          messageId: `${provider}-real-message-id`,
          text: decisionText.slice(35)
        })
      })
      expect(result.current.messages).toEqual([expect.objectContaining({ text: decisionText, complete: false })])
      act(() => emit(id, { type: 'turn_complete', stopReason: 'end_turn' }))
      expect(result.current.messages).toEqual([expect.objectContaining({ text: decisionText, complete: true })])
    }
  )
})

test('independent proposal-review questions do not collapse into one Agree decision', () => {
  const reviewQuestions = [
    'Nine tickets, ready to publish:',
    '',
    '1. **Establish the resource recovery rule**',
    '2. **Add terrain destruction**',
    '',
    'Before I publish them:',
    '',
    '- Does this granularity feel right?',
    '- Are the blocking edges correct?',
    '- Should any tickets be merged or split?',
    '- Does Agree confirm the proposed 50% Recovery Rate?'
  ].join('\n')

  renderChatView({ messages: [{ id: 'm-independent-review', role: 'assistant', text: reviewQuestions }] })

  expect(screen.queryByRole('region', { name: 'Pending decisions' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Agree' })).not.toBeInTheDocument()
  expect(screen.getByPlaceholderText(/Message the agent/)).toBeInTheDocument()
})

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import OrchestrationQuestionsStrip, {
  draftAnsweringQuestion,
  questionPreview
} from '../src/renderer/src/OrchestrationQuestionsStrip'
import type { OrchestrationControlState } from '../src/shared/ticket-session-spawn'

const request = { provider: 'claude' as const, conversationId: 'conv-1', nodeId: 'node-1' }

function state(openQuestions: OrchestrationControlState['openQuestions']): OrchestrationControlState {
  return { ...request, status: 'running', openQuestions } as OrchestrationControlState
}

const questions = [
  { id: 'Q1', ticketId: '3', markdown: 'Ship it?\n\n[shot](file:///D:/shot.png)', createdAt: 1 },
  { id: 'Q2', markdown: 'Second **bold**', createdAt: 2 }
]

let push: (next: OrchestrationControlState) => void = () => undefined
const api = {
  orchestrationState: vi.fn(),
  resolveQuestion: vi.fn(),
  onOrchestrationState: vi.fn()
}

beforeEach(() => {
  api.orchestrationState.mockReset().mockResolvedValue(state(questions))
  api.resolveQuestion.mockReset().mockResolvedValue(state([questions[1]]))
  api.onOrchestrationState.mockReset().mockImplementation((callback) => {
    push = callback
    return () => undefined
  })
  Object.defineProperty(window, 'orchestratorApi', { configurable: true, value: api })
})

async function openReader(): Promise<void> {
  fireEvent.click(await screen.findByRole('button', { name: /Offene (Frage|Fragen)/ }))
  await screen.findByRole('dialog')
}

test('the node shows one badge row with count, first question preview and an open action', async () => {
  render(<OrchestrationQuestionsStrip request={request} draft="" onDraftChange={vi.fn()} />)
  const badge = await screen.findByRole('button', { name: /Offene Fragen/ })
  expect(badge.querySelector('.orchestration-questions-count')?.textContent).toBe('2')
  expect(badge.querySelector('.orchestration-questions-preview')?.textContent).toBe('Q1: Ship it? shot')
  expect(badge.textContent).toContain('Öffnen')
  // Nothing of the question body lives in the node.
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(screen.queryByRole('button', { name: 'Erledigt' })).toBeNull()
  expect(document.querySelectorAll('.orchestration-question')).toHaveLength(0)
})

test('the badge uses the singular for one open question', async () => {
  api.orchestrationState.mockResolvedValue(state([questions[1]]))
  render(<OrchestrationQuestionsStrip request={request} draft="" onDraftChange={vi.fn()} />)
  expect(await screen.findByRole('button', { name: /Offene Frage(?!n)/ })).toBeTruthy()
})

test('renders nothing without open questions', async () => {
  api.orchestrationState.mockResolvedValue(state([]))
  const { container } = render(<OrchestrationQuestionsStrip request={request} draft="" onDraftChange={vi.fn()} />)
  await waitFor(() => expect(api.orchestrationState).toHaveBeenCalled())
  expect(container.firstChild).toBeNull()
})

test('the reader opens on document.body and lists every open question with id, ticket and rendered markdown', async () => {
  const { container } = render(<OrchestrationQuestionsStrip request={request} draft="" onDraftChange={vi.fn()} />)
  await openReader()
  const dialog = screen.getByRole('dialog', { name: 'Offene Fragen (2)' })
  expect(container.contains(dialog)).toBe(false)
  expect(document.body.contains(dialog)).toBe(true)
  expect(screen.getByText('Q1')).toBeTruthy()
  expect(screen.getByText('#3')).toBeTruthy()
  expect(screen.getByRole('link', { name: 'shot' })).toBeTruthy()
  expect(screen.getByText('bold').tagName).toBe('STRONG')
})

test('Escape closes the reader', async () => {
  render(<OrchestrationQuestionsStrip request={request} draft="" onDraftChange={vi.fn()} />)
  await openReader()
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(screen.getByRole('button', { name: /Offene Fragen/ })).toBeTruthy()
})

test('a click outside the panel closes the reader, a click inside does not', async () => {
  render(<OrchestrationQuestionsStrip request={request} draft="" onDraftChange={vi.fn()} />)
  await openReader()
  fireEvent.mouseDown(screen.getByText('Q1'))
  expect(screen.getByRole('dialog')).toBeTruthy()
  fireEvent.mouseDown(document.querySelector('.orchestration-reader-backdrop')!)
  expect(screen.queryByRole('dialog')).toBeNull()
})

test('the close button closes the reader', async () => {
  render(<OrchestrationQuestionsStrip request={request} draft="" onDraftChange={vi.fn()} />)
  await openReader()
  fireEvent.click(screen.getByRole('button', { name: 'Schließen' }))
  expect(screen.queryByRole('dialog')).toBeNull()
})

test('Erledigt resolves that question and drops it from the reader', async () => {
  render(<OrchestrationQuestionsStrip request={request} draft="" onDraftChange={vi.fn()} />)
  await openReader()
  const [first] = screen.getAllByRole('button', { name: 'Erledigt' })
  fireEvent.click(first)
  await waitFor(() => expect(screen.getByRole('dialog', { name: 'Offene Fragen (1)' })).toBeTruthy())
  expect(api.resolveQuestion).toHaveBeenCalledWith({ ...request, questionId: 'Q1' })
  expect(screen.queryByText('Q1')).toBeNull()
})

test('resolving the last question closes the reader and the badge goes away', async () => {
  api.orchestrationState.mockResolvedValue(state([questions[1]]))
  api.resolveQuestion.mockResolvedValue(state([]))
  render(<OrchestrationQuestionsStrip request={request} draft="" onDraftChange={vi.fn()} />)
  await openReader()
  fireEvent.click(screen.getByRole('button', { name: 'Erledigt' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(screen.queryByRole('button', { name: /Offene Frage/ })).toBeNull()
})

test('a question that arrives after the reader closed does not reopen it', async () => {
  api.orchestrationState.mockResolvedValue(state([questions[1]]))
  render(<OrchestrationQuestionsStrip request={request} draft="" onDraftChange={vi.fn()} />)
  await openReader()
  act(() => push(state([])))
  expect(screen.queryByRole('dialog')).toBeNull()
  act(() => push(state([questions[0]])))
  expect(screen.getByRole('button', { name: /Offene Frage/ })).toBeTruthy()
  expect(screen.queryByRole('dialog')).toBeNull()
})

const choiceQuestion = {
  id: 'Q3',
  ticketId: '5',
  markdown: 'Which branch?',
  options: [{ label: 'Left', description: 'the old one' }, { label: 'Right' }],
  createdAt: 3
}

test('a question with options renders the decision panel with clickable answers and Other', async () => {
  api.orchestrationState.mockResolvedValue(state([questions[1], choiceQuestion]))
  render(<OrchestrationQuestionsStrip request={request} draft="" onDraftChange={vi.fn()} />)
  await openReader()
  expect(await screen.findByRole('button', { name: /Left/ })).toBeTruthy()
  expect(screen.getByRole('button', { name: /Right/ })).toBeTruthy()
  expect(screen.getByText('the old one')).toBeTruthy()
  expect(screen.getByLabelText('Other answer')).toBeTruthy()
  // The plain-text question beside it has no panel: one panel in the reader.
  expect(document.querySelectorAll('.structured-decision')).toHaveLength(1)
})

test('picking an option and submitting resolves the question with the answer as its note', async () => {
  api.orchestrationState.mockResolvedValue(state([choiceQuestion]))
  api.resolveQuestion.mockResolvedValue(state([]))
  render(<OrchestrationQuestionsStrip request={request} draft="" onDraftChange={vi.fn()} />)
  await openReader()
  fireEvent.click(await screen.findByRole('button', { name: /Right/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Submit answers' }))
  await waitFor(() =>
    expect(api.resolveQuestion).toHaveBeenCalledWith({ ...request, questionId: 'Q3', note: 'Answer: Right' })
  )
})

test('an Other answer alone resolves with its text; Submit waits for some answer', async () => {
  api.orchestrationState.mockResolvedValue(state([choiceQuestion]))
  render(<OrchestrationQuestionsStrip request={request} draft="" onDraftChange={vi.fn()} />)
  await openReader()
  const submit = await screen.findByRole('button', { name: 'Submit answers' })
  expect((submit as HTMLButtonElement).disabled).toBe(true)
  fireEvent.change(screen.getByLabelText('Other answer'), { target: { value: 'Neither' } })
  expect((submit as HTMLButtonElement).disabled).toBe(false)
  fireEvent.click(submit)
  await waitFor(() =>
    expect(api.resolveQuestion).toHaveBeenCalledWith({ ...request, questionId: 'Q3', note: 'Answer: Neither' })
  )
})

test('Skip on the panel resolves it as unanswered', async () => {
  api.orchestrationState.mockResolvedValue(state([choiceQuestion]))
  render(<OrchestrationQuestionsStrip request={request} draft="" onDraftChange={vi.fn()} />)
  await openReader()
  fireEvent.click(await screen.findByRole('button', { name: 'Skip' }))
  await waitFor(() =>
    expect(api.resolveQuestion).toHaveBeenCalledWith({
      ...request,
      questionId: 'Q3',
      note: 'Skipped without an answer.'
    })
  )
})

test('a failed resolve leaves the panel usable again', async () => {
  api.orchestrationState.mockResolvedValue(state([choiceQuestion]))
  api.resolveQuestion.mockRejectedValueOnce(new Error('ipc down'))
  render(<OrchestrationQuestionsStrip request={request} draft="" onDraftChange={vi.fn()} />)
  await openReader()
  fireEvent.click(await screen.findByRole('button', { name: /Left/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Submit answers' }))
  await waitFor(() => expect(api.resolveQuestion).toHaveBeenCalledTimes(1))
  fireEvent.click(await screen.findByRole('button', { name: /Left/ }))
  await waitFor(() =>
    expect((screen.getByRole('button', { name: 'Submit answers' }) as HTMLButtonElement).disabled).toBe(false)
  )
})

test('Antworten prefills the composer draft for that question', async () => {
  const onDraftChange = vi.fn()
  render(<OrchestrationQuestionsStrip request={request} draft="" onDraftChange={onDraftChange} />)
  await openReader()
  const buttons = await screen.findAllByRole('button', { name: 'Antworten' })
  fireEvent.click(buttons[1])
  expect(onDraftChange).toHaveBeenCalledWith('Zu Q2: ')
  // The reader covers the composer, so Antworten hands the screen back to it.
  expect(screen.queryByRole('dialog')).toBeNull()
})

test('a pushed state for this orchestration updates the badge, another one is ignored', async () => {
  render(<OrchestrationQuestionsStrip request={request} draft="" onDraftChange={vi.fn()} />)
  await screen.findByRole('button', { name: /Offene Fragen/ })
  act(() => push({ ...state([]), conversationId: 'other' }))
  expect(screen.getByRole('button', { name: /Offene Fragen/ }).textContent).toContain('2')
  act(() => push(state([])))
  expect(screen.queryByRole('button', { name: /Offene Fragen?/ })).toBeNull()
})

test('draftAnsweringQuestion keeps an existing draft on its own line', () => {
  expect(draftAnsweringQuestion('', 'Q3')).toBe('Zu Q3: ')
  expect(draftAnsweringQuestion('hi', 'Q3')).toBe('hi\nZu Q3: ')
  expect(draftAnsweringQuestion('hi\n', 'Q3')).toBe('hi\nZu Q3: ')
})

test('questionPreview is one plain-text line led by the question id', () => {
  expect(questionPreview('Q4', 'Soll der **Merge** von [#12](file:///x) laufen?\n\nZweiter Absatz')).toBe(
    'Q4: Soll der Merge von #12 laufen? Zweiter Absatz'
  )
  expect(questionPreview('Q5', '  \n')).toBe('Q5')
})

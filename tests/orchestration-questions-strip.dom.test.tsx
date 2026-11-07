import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import OrchestrationQuestionsStrip, { draftAnsweringQuestion } from '../src/renderer/src/OrchestrationQuestionsStrip'
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

test('lists every open question with id, ticket and rendered markdown', async () => {
  render(<OrchestrationQuestionsStrip request={request} draft="" onDraftChange={vi.fn()} />)
  expect(await screen.findByText('Offene Fragen (2)')).toBeTruthy()
  expect(screen.getByText('Q1')).toBeTruthy()
  expect(screen.getByText('#3')).toBeTruthy()
  expect(screen.getByRole('link', { name: 'shot' })).toBeTruthy()
  expect(screen.getByText('bold').tagName).toBe('STRONG')
})

test('renders nothing without open questions', async () => {
  api.orchestrationState.mockResolvedValue(state([]))
  const { container } = render(<OrchestrationQuestionsStrip request={request} draft="" onDraftChange={vi.fn()} />)
  await waitFor(() => expect(api.orchestrationState).toHaveBeenCalled())
  expect(container.firstChild).toBeNull()
})

test('collapses and expands', async () => {
  render(<OrchestrationQuestionsStrip request={request} draft="" onDraftChange={vi.fn()} />)
  fireEvent.click(await screen.findByRole('button', { name: /Offene Fragen/ }))
  expect(screen.queryByText('Q1')).toBeNull()
  expect(screen.getByText('Offene Fragen (2)')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: /Offene Fragen/ }))
  expect(screen.getByText('Q1')).toBeTruthy()
})

test('Erledigt resolves that question and drops it from the strip', async () => {
  render(<OrchestrationQuestionsStrip request={request} draft="" onDraftChange={vi.fn()} />)
  const [first] = await screen.findAllByRole('button', { name: 'Erledigt' })
  fireEvent.click(first)
  await waitFor(() => expect(screen.getByText('Offene Fragen (1)')).toBeTruthy())
  expect(api.resolveQuestion).toHaveBeenCalledWith({ ...request, questionId: 'Q1' })
  expect(screen.queryByText('Q1')).toBeNull()
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
  expect(await screen.findByRole('button', { name: /Left/ })).toBeTruthy()
  expect(screen.getByRole('button', { name: /Right/ })).toBeTruthy()
  expect(screen.getByText('the old one')).toBeTruthy()
  expect(screen.getByLabelText('Other answer')).toBeTruthy()
  // The plain-text question beside it has no panel: one panel in the strip.
  expect(document.querySelectorAll('.structured-decision')).toHaveLength(1)
})

test('picking an option and submitting resolves the question with the answer as its note', async () => {
  api.orchestrationState.mockResolvedValue(state([choiceQuestion]))
  api.resolveQuestion.mockResolvedValue(state([]))
  render(<OrchestrationQuestionsStrip request={request} draft="" onDraftChange={vi.fn()} />)
  fireEvent.click(await screen.findByRole('button', { name: /Right/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Submit answers' }))
  await waitFor(() =>
    expect(api.resolveQuestion).toHaveBeenCalledWith({ ...request, questionId: 'Q3', note: 'Answer: Right' })
  )
})

test('an Other answer alone resolves with its text; Submit waits for some answer', async () => {
  api.orchestrationState.mockResolvedValue(state([choiceQuestion]))
  render(<OrchestrationQuestionsStrip request={request} draft="" onDraftChange={vi.fn()} />)
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
  const buttons = await screen.findAllByRole('button', { name: 'Antworten' })
  fireEvent.click(buttons[1])
  expect(onDraftChange).toHaveBeenCalledWith('Zu Q2: ')
})

test('a pushed state for this orchestration updates the strip, another one is ignored', async () => {
  render(<OrchestrationQuestionsStrip request={request} draft="" onDraftChange={vi.fn()} />)
  await screen.findByText('Offene Fragen (2)')
  act(() => push({ ...state([]), conversationId: 'other' }))
  expect(screen.getByText('Offene Fragen (2)')).toBeTruthy()
  act(() => push(state([])))
  expect(screen.queryByText(/Offene Fragen/)).toBeNull()
})

test('draftAnsweringQuestion keeps an existing draft on its own line', () => {
  expect(draftAnsweringQuestion('', 'Q3')).toBe('Zu Q3: ')
  expect(draftAnsweringQuestion('hi', 'Q3')).toBe('hi\nZu Q3: ')
  expect(draftAnsweringQuestion('hi\n', 'Q3')).toBe('hi\nZu Q3: ')
})

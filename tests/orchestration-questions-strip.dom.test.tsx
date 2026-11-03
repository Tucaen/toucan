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

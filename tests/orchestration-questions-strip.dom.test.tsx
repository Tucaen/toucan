import { act, createEvent, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import OrchestrationQuestionsStrip, { questionPreview } from '../src/renderer/src/OrchestrationQuestionsStrip'
import { forgetReaderRects } from '../src/renderer/src/orchestration-reader-geometry'
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
  forgetReaderRects()
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
  render(<OrchestrationQuestionsStrip request={request} />)
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
  render(<OrchestrationQuestionsStrip request={request} />)
  expect(await screen.findByRole('button', { name: /Offene Frage(?!n)/ })).toBeTruthy()
})

test('renders nothing without open questions', async () => {
  api.orchestrationState.mockResolvedValue(state([]))
  const { container } = render(<OrchestrationQuestionsStrip request={request} />)
  await waitFor(() => expect(api.orchestrationState).toHaveBeenCalled())
  expect(container.firstChild).toBeNull()
})

test('the reader opens on document.body and lists every open question with id, ticket and rendered markdown', async () => {
  const { container } = render(<OrchestrationQuestionsStrip request={request} />)
  await openReader()
  const dialog = screen.getByRole('dialog', { name: 'Offene Fragen (2)' })
  expect(container.contains(dialog)).toBe(false)
  expect(document.body.contains(dialog)).toBe(true)
  expect(screen.getByText('Q1')).toBeTruthy()
  expect(screen.getByText('#3')).toBeTruthy()
  expect(screen.getByRole('link', { name: 'shot' })).toBeTruthy()
  expect(screen.getByText('bold').tagName).toBe('STRONG')
})

test('the reader is a non-modal window: no backdrop, no aria-modal, no focus trap', async () => {
  render(<OrchestrationQuestionsStrip request={request} />)
  await openReader()
  const dialog = screen.getByRole('dialog')
  expect(dialog.getAttribute('aria-modal')).toBeNull()
  expect(document.querySelector('.orchestration-reader-backdrop, .dialog-overlay')).toBeNull()
  // Tab is left to the browser: the window does not intercept it.
  const tab = createEvent.keyDown(dialog, { key: 'Tab' })
  fireEvent(dialog, tab)
  expect(tab.defaultPrevented).toBe(false)
})

test('opening the reader moves focus into the first answer field', async () => {
  render(<OrchestrationQuestionsStrip request={request} />)
  await openReader()
  expect(document.activeElement).toBe(screen.getByLabelText('Antwort auf Q1'))
})

test('Escape closes the reader while focus is inside it and hands focus back to the badge', async () => {
  render(<OrchestrationQuestionsStrip request={request} />)
  await openReader()
  fireEvent.keyDown(screen.getByLabelText('Antwort auf Q1'), { key: 'Escape' })
  expect(screen.queryByRole('dialog')).toBeNull()
  const badge = screen.getByRole('button', { name: /Offene Fragen/ })
  expect(badge).toBeTruthy()
  expect(document.activeElement).toBe(badge)
})

test('Escape elsewhere and clicks outside leave the reader open', async () => {
  render(<OrchestrationQuestionsStrip request={request} />)
  await openReader()
  fireEvent.keyDown(document.body, { key: 'Escape' })
  fireEvent.mouseDown(document.body)
  fireEvent.click(document.body)
  fireEvent.mouseDown(screen.getByRole('button', { name: /Offene Fragen/ }))
  expect(screen.getByRole('dialog')).toBeTruthy()
})

test('keys typed in the reader and clicks on it do not reach the node around it', async () => {
  const onKeyDown = vi.fn()
  const onMouseDown = vi.fn()
  const onClick = vi.fn()
  render(
    <div onKeyDown={onKeyDown} onMouseDown={onMouseDown} onClick={onClick}>
      <OrchestrationQuestionsStrip request={request} />
    </div>
  )
  await openReader()
  onClick.mockClear()
  fireEvent.keyDown(screen.getByLabelText('Antwort auf Q1'), { key: 'a' })
  fireEvent.mouseDown(screen.getByText('Q1'))
  fireEvent.click(screen.getByText('Q1'))
  expect(onKeyDown).not.toHaveBeenCalled()
  expect(onMouseDown).not.toHaveBeenCalled()
  expect(onClick).not.toHaveBeenCalled()
})

test('the badge brings an open reader forward instead of closing it', async () => {
  render(<OrchestrationQuestionsStrip request={request} />)
  await openReader()
  screen.getAllByRole('button', { name: 'Erledigt' })[0].focus()
  fireEvent.click(screen.getByRole('button', { name: /Offene Fragen/, expanded: true }))
  expect(screen.getByRole('dialog')).toBeTruthy()
  expect(document.activeElement).toBe(screen.getByLabelText('Antwort auf Q1'))
})

test('the close button closes the reader', async () => {
  render(<OrchestrationQuestionsStrip request={request} />)
  await openReader()
  fireEvent.click(screen.getByRole('button', { name: 'Schließen' }))
  expect(screen.queryByRole('dialog')).toBeNull()
})

test('Erledigt resolves that question and drops it from the reader', async () => {
  render(<OrchestrationQuestionsStrip request={request} />)
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
  render(<OrchestrationQuestionsStrip request={request} />)
  await openReader()
  fireEvent.click(screen.getByRole('button', { name: 'Erledigt' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(screen.queryByRole('button', { name: /Offene Frage/ })).toBeNull()
})

test('a question that arrives after the reader closed does not reopen it', async () => {
  api.orchestrationState.mockResolvedValue(state([questions[1]]))
  render(<OrchestrationQuestionsStrip request={request} />)
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
  render(<OrchestrationQuestionsStrip request={request} />)
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
  render(<OrchestrationQuestionsStrip request={request} />)
  await openReader()
  fireEvent.click(await screen.findByRole('button', { name: /Right/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Submit answers' }))
  await waitFor(() =>
    expect(api.resolveQuestion).toHaveBeenCalledWith({ ...request, questionId: 'Q3', note: 'Answer: Right' })
  )
})

test('an Other answer alone resolves with its text; Submit waits for some answer', async () => {
  api.orchestrationState.mockResolvedValue(state([choiceQuestion]))
  render(<OrchestrationQuestionsStrip request={request} />)
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
  render(<OrchestrationQuestionsStrip request={request} />)
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
  render(<OrchestrationQuestionsStrip request={request} />)
  await openReader()
  fireEvent.click(await screen.findByRole('button', { name: /Left/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Submit answers' }))
  await waitFor(() => expect(api.resolveQuestion).toHaveBeenCalledTimes(1))
  fireEvent.click(await screen.findByRole('button', { name: /Left/ }))
  await waitFor(() =>
    expect((screen.getByRole('button', { name: 'Submit answers' }) as HTMLButtonElement).disabled).toBe(false)
  )
})

test('a question without options has its own answer field under the question, none with options', async () => {
  api.orchestrationState.mockResolvedValue(state([questions[1], choiceQuestion]))
  render(<OrchestrationQuestionsStrip request={request} />)
  await openReader()
  const plain = document.querySelector('[data-question-id="Q2"]')!
  expect(plain.querySelector('textarea')).toBe(screen.getByLabelText('Antwort auf Q2'))
  expect(screen.queryByLabelText('Antwort auf Q3')).toBeNull()
  // The old composer hand-off is gone: typing the answer here replaces it.
  expect(screen.queryByRole('button', { name: 'Antworten' })).toBeNull()
})

test('a typed answer resolves its question with the same note an Other answer gets', async () => {
  render(<OrchestrationQuestionsStrip request={request} />)
  await openReader()
  const send = screen.getAllByRole('button', { name: 'Senden' })[0] as HTMLButtonElement
  expect(send.disabled).toBe(true)
  fireEvent.change(screen.getByLabelText('Antwort auf Q1'), { target: { value: '  Yes, ship it.  ' } })
  expect(send.disabled).toBe(false)
  fireEvent.click(send)
  await waitFor(() =>
    expect(api.resolveQuestion).toHaveBeenCalledWith({ ...request, questionId: 'Q1', note: 'Answer: Yes, ship it.' })
  )
  // Q2 is still open, so the window stays.
  await waitFor(() => expect(screen.getByRole('dialog', { name: 'Offene Fragen (1)' })).toBeTruthy())
})

test('Ctrl+Enter and Cmd+Enter send the typed answer, Enter alone and an empty field do not', async () => {
  render(<OrchestrationQuestionsStrip request={request} />)
  await openReader()
  const field = screen.getByLabelText('Antwort auf Q1')
  fireEvent.keyDown(field, { key: 'Enter', ctrlKey: true })
  expect(api.resolveQuestion).not.toHaveBeenCalled()
  fireEvent.change(field, { target: { value: 'one' } })
  fireEvent.keyDown(field, { key: 'Enter' })
  expect(api.resolveQuestion).not.toHaveBeenCalled()
  fireEvent.keyDown(field, { key: 'Enter', ctrlKey: true })
  await waitFor(() => expect(api.resolveQuestion).toHaveBeenCalledTimes(1))
  expect(api.resolveQuestion).toHaveBeenLastCalledWith({ ...request, questionId: 'Q1', note: 'Answer: one' })
  fireEvent.change(screen.getByLabelText('Antwort auf Q2'), { target: { value: 'two' } })
  fireEvent.keyDown(screen.getByLabelText('Antwort auf Q2'), { key: 'Enter', metaKey: true })
  await waitFor(() => expect(api.resolveQuestion).toHaveBeenCalledTimes(2))
  expect(api.resolveQuestion).toHaveBeenLastCalledWith({ ...request, questionId: 'Q2', note: 'Answer: two' })
})

test('typed answers survive closing and reopening the window, and a failed send keeps the text', async () => {
  api.resolveQuestion.mockRejectedValueOnce(new Error('ipc down'))
  render(<OrchestrationQuestionsStrip request={request} />)
  await openReader()
  fireEvent.change(screen.getByLabelText('Antwort auf Q1'), { target: { value: 'a long thought' } })
  fireEvent.click(screen.getAllByRole('button', { name: 'Senden' })[0])
  await waitFor(() => expect(api.resolveQuestion).toHaveBeenCalledTimes(1))
  await waitFor(() =>
    expect((screen.getAllByRole('button', { name: 'Senden' })[0] as HTMLButtonElement).disabled).toBe(false)
  )
  expect((screen.getByLabelText('Antwort auf Q1') as HTMLTextAreaElement).value).toBe('a long thought')
  fireEvent.click(screen.getByRole('button', { name: 'Schließen' }))
  await openReader()
  expect((screen.getByLabelText('Antwort auf Q1') as HTMLTextAreaElement).value).toBe('a long thought')
})

test('resolving the last question with a typed answer closes the window', async () => {
  api.orchestrationState.mockResolvedValue(state([questions[1]]))
  api.resolveQuestion.mockResolvedValue(state([]))
  render(<OrchestrationQuestionsStrip request={request} />)
  await openReader()
  fireEvent.change(screen.getByLabelText('Antwort auf Q2'), { target: { value: 'done' } })
  fireEvent.keyDown(screen.getByLabelText('Antwort auf Q2'), { key: 'Enter', ctrlKey: true })
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
})

function windowStyle(): { left: number; top: number; width: number; height: number } {
  const style = (screen.getByRole('dialog') as HTMLElement).style
  return {
    left: parseInt(style.left, 10),
    top: parseInt(style.top, 10),
    width: parseInt(style.width, 10),
    height: parseInt(style.height, 10)
  }
}

function drag(handle: Element, from: [number, number], to: [number, number]): void {
  fireEvent.mouseDown(handle, { button: 0, clientX: from[0], clientY: from[1] })
  fireEvent.mouseMove(document, { clientX: to[0], clientY: to[1] })
  fireEvent.mouseUp(document)
}

test('the title bar drags the window, the close button does not, and it stays inside the viewport', async () => {
  render(<OrchestrationQuestionsStrip request={request} />)
  await openReader()
  const before = windowStyle()
  const header = document.querySelector('.orchestration-reader-header')!
  drag(header, [500, 70], [440, 100])
  expect(windowStyle()).toEqual({ ...before, left: before.left - 60, top: before.top + 30 })
  drag(screen.getByRole('button', { name: 'Schließen' }), [10, 10], [-300, -300])
  expect(windowStyle().left).toBe(before.left - 60)
  drag(header, [500, 70], [-5000, -5000])
  expect(windowStyle()).toMatchObject({ left: 8, top: 8 })
  drag(header, [0, 0], [9000, 9000])
  const after = windowStyle()
  expect(after.left + after.width).toBe(window.innerWidth - 8)
  expect(after.top + after.height).toBe(window.innerHeight - 8)
})

test('the bottom-right corner resizes within the minimum and maximum', async () => {
  render(<OrchestrationQuestionsStrip request={request} />)
  await openReader()
  const before = windowStyle()
  const corner = document.querySelector('.orchestration-reader-resize')!
  drag(corner, [0, 0], [-100, -50])
  expect(windowStyle()).toEqual({ ...before, width: before.width - 100, height: before.height - 50 })
  drag(corner, [0, 0], [-9000, -9000])
  expect(windowStyle()).toMatchObject({ width: 340, height: 280 })
  drag(corner, [0, 0], [9000, 9000])
  const grown = windowStyle()
  expect(grown.left + grown.width).toBeLessThanOrEqual(window.innerWidth - 8)
  expect(grown.top + grown.height).toBeLessThanOrEqual(window.innerHeight - 8)
})

test('reopening restores the last position and size of that orchestrator node', async () => {
  const { unmount } = render(<OrchestrationQuestionsStrip request={request} />)
  await openReader()
  drag(document.querySelector('.orchestration-reader-header')!, [500, 70], [400, 120])
  drag(document.querySelector('.orchestration-reader-resize')!, [0, 0], [-80, -60])
  const moved = windowStyle()
  fireEvent.click(screen.getByRole('button', { name: 'Schließen' }))
  await openReader()
  expect(windowStyle()).toEqual(moved)
  unmount()
  // Another node starts at the default place.
  render(<OrchestrationQuestionsStrip request={{ ...request, nodeId: 'node-2' }} />)
  await openReader()
  expect(windowStyle()).not.toEqual(moved)
})

test('a smaller browser window pulls the reader back inside', async () => {
  render(<OrchestrationQuestionsStrip request={request} />)
  await openReader()
  const original = window.innerWidth
  try {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 600 })
    act(() => {
      window.dispatchEvent(new Event('resize'))
    })
    const rect = windowStyle()
    expect(rect.left + rect.width).toBeLessThanOrEqual(600 - 8)
  } finally {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: original })
  }
})

test('a pushed state for this orchestration updates the badge, another one is ignored', async () => {
  render(<OrchestrationQuestionsStrip request={request} />)
  await screen.findByRole('button', { name: /Offene Fragen/ })
  act(() => push({ ...state([]), conversationId: 'other' }))
  expect(screen.getByRole('button', { name: /Offene Fragen/ }).textContent).toContain('2')
  act(() => push(state([])))
  expect(screen.queryByRole('button', { name: /Offene Fragen?/ })).toBeNull()
})

test('questionPreview is one plain-text line led by the question id', () => {
  expect(questionPreview('Q4', 'Soll der **Merge** von [#12](file:///x) laufen?\n\nZweiter Absatz')).toBe(
    'Q4: Soll der Merge von #12 laufen? Zweiter Absatz'
  )
  expect(questionPreview('Q5', '  \n')).toBe('Q5')
})

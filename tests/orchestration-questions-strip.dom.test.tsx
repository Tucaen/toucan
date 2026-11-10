import { act, createEvent, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import OrchestrationQuestionsStrip, { questionPreview } from '../src/renderer/src/OrchestrationQuestionsStrip'
import { questionTabAfterChange } from '../src/renderer/src/OrchestrationQuestionsReader'
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
  document.querySelectorAll('.canvas-region').forEach((element) => element.remove())
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

function selectTab(name: RegExp): void {
  fireEvent.click(screen.getByRole('tab', { name }))
}

/** The question shown: the one panel not hidden, which the selected tab controls. */
function shownQuestion(): string | null {
  const panels = [...document.querySelectorAll<HTMLElement>('.orchestration-question')].filter((panel) => !panel.hidden)
  expect(panels).toHaveLength(1)
  expect(screen.getByRole('tab', { selected: true }).getAttribute('aria-controls')).toBe(panels[0].id)
  return panels[0].getAttribute('data-question-id')
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

test('the reader opens on document.body with one tab per open question, labelled with id and ticket', async () => {
  const { container } = render(<OrchestrationQuestionsStrip request={request} />)
  await openReader()
  const dialog = screen.getByRole('dialog', { name: 'Offene Fragen (2)' })
  expect(container.contains(dialog)).toBe(false)
  expect(document.body.contains(dialog)).toBe(true)
  const tabs = screen.getAllByRole('tab')
  expect(tabs.map((tab) => tab.textContent)).toEqual(['Q1 #3', 'Q2'])
  expect(tabs.map((tab) => tab.getAttribute('aria-selected'))).toEqual(['true', 'false'])
  expect(screen.getByRole('tabpanel', { name: /Q1/ })).toBeTruthy()
  expect(screen.getByRole('link', { name: 'shot' })).toBeTruthy()
  expect(shownQuestion()).toBe('Q1')
})

test('a tab shows its question alone and keeps the others mounted', async () => {
  render(<OrchestrationQuestionsStrip request={request} />)
  await openReader()
  selectTab(/Q2/)
  expect(shownQuestion()).toBe('Q2')
  expect(screen.getByText('bold').tagName).toBe('STRONG')
  expect(screen.getByRole('tabpanel', { name: /Q2/ })).toBeTruthy()
  // The hidden question keeps its answer field, so switching tabs loses nothing typed there.
  expect(screen.getByLabelText('Antwort auf Q1')).toBeTruthy()
  selectTab(/Q1/)
  expect(shownQuestion()).toBe('Q1')
})

test('Arrow keys on the tab row move between questions and wrap around', async () => {
  render(<OrchestrationQuestionsStrip request={request} />)
  await openReader()
  const first = screen.getByRole('tab', { name: /Q1/ })
  first.focus()
  fireEvent.keyDown(first, { key: 'ArrowRight' })
  expect(shownQuestion()).toBe('Q2')
  expect(document.activeElement).toBe(screen.getByRole('tab', { name: /Q2/ }))
  fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' })
  expect(shownQuestion()).toBe('Q1')
  fireEvent.keyDown(document.activeElement!, { key: 'ArrowLeft' })
  expect(shownQuestion()).toBe('Q2')
})

test('resolving the selected question selects its neighbour, a new question leaves the selection alone', async () => {
  const third = { id: 'Q4', markdown: 'Third', createdAt: 4 }
  api.orchestrationState.mockResolvedValue(state([...questions, third]))
  api.resolveQuestion.mockResolvedValue(state([questions[0], third]))
  render(<OrchestrationQuestionsStrip request={request} />)
  await openReader()
  selectTab(/Q2/)
  fireEvent.click(screen.getByRole('button', { name: 'Erledigt' }))
  await waitFor(() => expect(screen.queryByRole('tab', { name: /Q2/ })).toBeNull())
  expect(api.resolveQuestion).toHaveBeenCalledWith({ ...request, questionId: 'Q2' })
  // The one after it takes its place, as a closed browser tab hands over to its right neighbour.
  expect(shownQuestion()).toBe('Q4')
  act(() => push(state([questions[0], third, choiceQuestion])))
  expect(screen.getAllByRole('tab')).toHaveLength(3)
  expect(shownQuestion()).toBe('Q4')
  // The last tab resolved: its left neighbour is next.
  act(() => push(state([questions[0], third])))
  act(() => push(state([questions[0]])))
  expect(shownQuestion()).toBe('Q1')
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

test('opening the reader moves focus into the selected question’s answer field', async () => {
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
  expect(shownQuestion()).toBe('Q2')
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
  selectTab(/Q3/)
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
  selectTab(/Q2/)
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

test('an answered question takes its focused Send button along, and focus moves to the next question', async () => {
  render(<OrchestrationQuestionsStrip request={request} />)
  await openReader()
  fireEvent.change(screen.getByLabelText('Antwort auf Q1'), { target: { value: 'yes' } })
  const send = screen.getByRole('button', { name: 'Senden' })
  send.focus()
  fireEvent.click(send)
  await waitFor(() => expect(screen.queryByRole('tab', { name: /Q1/ })).toBeNull())
  // Not the page: from there Alt+Arrow and typing would reach the canvas instead of the window.
  expect(document.activeElement).toBe(screen.getByLabelText('Antwort auf Q2'))
})

test('focus the browser drops off a disabled Erledigt still lands in the next question', async () => {
  let finish: (next: OrchestrationControlState) => void = () => undefined
  api.resolveQuestion.mockReturnValue(new Promise((done) => (finish = done)))
  render(<OrchestrationQuestionsStrip request={request} />)
  await openReader()
  const erledigt = screen.getByRole('button', { name: 'Erledigt' })
  erledigt.focus()
  fireEvent.click(erledigt)
  // Chromium drops focus off a disabled button to the page; jsdom does not, so it is done by hand.
  act(() => (document.activeElement as HTMLElement).blur())
  expect(document.activeElement).toBe(document.body)
  await act(async () => finish(state([questions[1]])))
  expect(document.activeElement).toBe(screen.getByLabelText('Antwort auf Q2'))
})

test('a question resolved elsewhere does not pull focus into the window', async () => {
  render(<OrchestrationQuestionsStrip request={request} />)
  await openReader()
  const outside = document.createElement('button')
  document.body.append(outside)
  try {
    outside.focus()
    act(() => push(state([questions[1]])))
    expect(document.activeElement).toBe(outside)
  } finally {
    outside.remove()
  }
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

test('the bottom-right corner resizes without a minimum or maximum', async () => {
  render(<OrchestrationQuestionsStrip request={request} />)
  await openReader()
  const before = windowStyle()
  const corner = document.querySelector('.orchestration-reader-resize')!
  drag(corner, [0, 0], [-100, -50])
  expect(windowStyle()).toEqual({ ...before, width: before.width - 100, height: before.height - 50 })
  drag(corner, [0, 0], [-9000, -9000])
  expect(windowStyle()).toMatchObject({ width: 1, height: 1 })
  drag(corner, [0, 0], [9000, 9000])
  expect(windowStyle()).toMatchObject({ width: 9001, height: 9001 })
})

test('Alt+Arrow arranges the window like a node, also from its answer field, and Alt+Down restores it', async () => {
  render(<OrchestrationQuestionsStrip request={request} />)
  await openReader()
  const before = windowStyle()
  const field = screen.getByLabelText('Antwort auf Q1')
  fireEvent.keyDown(field, { key: 'ArrowLeft', code: 'ArrowLeft', altKey: true })
  expect(windowStyle()).toEqual({
    left: 16,
    top: 16,
    width: (window.innerWidth - 48) / 2,
    height: window.innerHeight - 32
  })
  fireEvent.keyDown(field, { key: 'ArrowUp', code: 'ArrowUp', altKey: true })
  expect(windowStyle().height).toBe((window.innerHeight - 48) / 2)
  // Top quarter -> left half -> bottom quarter -> back where it was.
  for (let press = 0; press < 3; press += 1)
    fireEvent.keyDown(field, { key: 'ArrowDown', code: 'ArrowDown', altKey: true })
  expect(windowStyle()).toEqual(before)
})

test('Alt+Arrow also works from the decision panel’s one-line Other field, which opening focuses', async () => {
  api.orchestrationState.mockResolvedValue(state([choiceQuestion]))
  render(<OrchestrationQuestionsStrip request={request} />)
  await openReader()
  const other = await screen.findByLabelText('Other answer')
  expect(other.tagName).toBe('INPUT')
  const press = createEvent.keyDown(other, { key: 'ArrowLeft', code: 'ArrowLeft', altKey: true })
  fireEvent(other, press)
  expect(press.defaultPrevented).toBe(true)
  expect(windowStyle()).toMatchObject({ left: 16, top: 16 })
})

test('grabbing the title bar takes focus into the window, so the next Alt+Arrow reaches it', async () => {
  render(<OrchestrationQuestionsStrip request={request} />)
  await openReader()
  const outside = document.createElement('button')
  document.body.append(outside)
  try {
    outside.focus()
    drag(document.querySelector('.orchestration-reader-header h2')!, [500, 70], [500, 70])
    expect(document.activeElement).toBe(screen.getByRole('dialog'))
  } finally {
    outside.remove()
  }
})

/** The app's canvas region, which a node's fullscreen fills: right of the sidebar, under the top bar. */
function canvasRegion(rect: { left: number; top: number; width: number; height: number }): void {
  const element = document.createElement('section')
  element.className = 'canvas-region'
  element.getBoundingClientRect = () =>
    ({ ...rect, x: rect.left, y: rect.top, right: rect.left + rect.width, bottom: rect.top + rect.height }) as DOMRect
  document.body.append(element)
}

test('fullscreen and the Alt+Arrow slices fill the node-fullscreen area, not the whole window', async () => {
  canvasRegion({ left: 240, top: 52, width: window.innerWidth - 240, height: window.innerHeight - 52 })
  render(<OrchestrationQuestionsStrip request={request} />)
  await openReader()
  fireEvent.click(screen.getByRole('button', { name: 'Fit to canvas' }))
  expect(windowStyle()).toEqual({
    left: 256,
    top: 68,
    width: window.innerWidth - 240 - 32,
    height: window.innerHeight - 52 - 32
  })
  fireEvent.click(screen.getByRole('button', { name: 'Restore' }))
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'ArrowRight', code: 'ArrowRight', altKey: true })
  const right = windowStyle()
  expect(right).toMatchObject({ top: 68, width: (window.innerWidth - 240 - 48) / 2 })
  expect(right.left + right.width).toBe(window.innerWidth - 16)
})

test('the header has the canvas fit button: it maximises, flips to Restore and restores', async () => {
  render(<OrchestrationQuestionsStrip request={request} />)
  await openReader()
  const before = windowStyle()
  fireEvent.click(screen.getByRole('button', { name: 'Fit to canvas' }))
  expect(windowStyle()).toEqual({ left: 16, top: 16, width: window.innerWidth - 32, height: window.innerHeight - 32 })
  fireEvent.click(screen.getByRole('button', { name: 'Restore' }))
  expect(windowStyle()).toEqual(before)
  expect(screen.getByRole('button', { name: 'Fit to canvas' }).getAttribute('title')).toContain('Alt+↑')
})

test('dragging the title bar frees a maximised window', async () => {
  render(<OrchestrationQuestionsStrip request={request} />)
  await openReader()
  fireEvent.click(screen.getByRole('button', { name: 'Fit to canvas' }))
  drag(document.querySelector('.orchestration-reader-header')!, [500, 70], [480, 70])
  expect(screen.getByRole('button', { name: 'Fit to canvas' })).toBeTruthy()
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

test('questionTabAfterChange keeps a live selection and hands a resolved one to its neighbour', () => {
  expect(questionTabAfterChange([], ['Q1', 'Q2'], undefined)).toBe('Q1')
  expect(questionTabAfterChange(['Q1', 'Q2'], ['Q1', 'Q2', 'Q3'], 'Q2')).toBe('Q2')
  expect(questionTabAfterChange(['Q1', 'Q2', 'Q3'], ['Q1', 'Q3'], 'Q2')).toBe('Q3')
  expect(questionTabAfterChange(['Q1', 'Q2', 'Q3'], ['Q1', 'Q2'], 'Q3')).toBe('Q2')
  expect(questionTabAfterChange(['Q1', 'Q2'], ['Q5'], 'Q2')).toBe('Q5')
  expect(questionTabAfterChange(['Q1'], [], 'Q1')).toBeUndefined()
})

test('questionPreview is one plain-text line led by the question id', () => {
  expect(questionPreview('Q4', 'Soll der **Merge** von [#12](file:///x) laufen?\n\nZweiter Absatz')).toBe(
    'Q4: Soll der Merge von #12 laufen? Zweiter Absatz'
  )
  expect(questionPreview('Q5', '  \n')).toBe('Q5')
})

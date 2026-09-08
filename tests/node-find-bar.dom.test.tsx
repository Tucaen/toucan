import { useRef, useState } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import FindBar from '../src/renderer/src/FindBar'

/*
 * The shared in-node find bar (issue #170): the file node's rendered view uses it today, AI-chat
 * and diff nodes next. jsdom has neither layout nor the CSS Custom Highlight API, so what is under
 * test here is the count, the navigation and the way it follows content that changes - the
 * highlighting itself is a no-op without the API and must not be what any of this depends on.
 */

function Harness({ paragraphs, onClose }: { paragraphs: string[]; onClose: () => void }): JSX.Element {
  const container = useRef<HTMLDivElement>(null)
  const [text, setText] = useState(paragraphs)
  return (
    <div>
      <FindBar
        containerRef={container}
        contentKey={text.join('\n')}
        openSignal={1}
        label="Find in document"
        onClose={onClose}
      />
      <div ref={container}>
        {text.map((paragraph, index) => (
          <p key={index}>{paragraph}</p>
        ))}
      </div>
      <button type="button" onClick={() => setText([...text, 'a late alpha'])}>
        Append
      </button>
    </div>
  )
}

function renderBar(paragraphs: string[] = ['alpha beta', 'Alpha gamma']): { onClose: ReturnType<typeof vi.fn> } {
  const onClose = vi.fn()
  render(<Harness paragraphs={paragraphs} onClose={onClose} />)
  return { onClose }
}

const input = (): HTMLElement => screen.getByLabelText('Find in document')
const count = (): string => screen.getByRole('status').textContent ?? ''

test('the find bar counts matches case-insensitively and starts on the first one', () => {
  renderBar()
  expect(count()).toBe('')
  fireEvent.change(input(), { target: { value: 'alpha' } })
  expect(count()).toBe('1 of 2')
})

test('Enter and Shift+Enter step through matches and wrap at both ends', () => {
  renderBar()
  fireEvent.change(input(), { target: { value: 'alpha' } })
  fireEvent.keyDown(input(), { key: 'Enter' })
  expect(count()).toBe('2 of 2')
  fireEvent.keyDown(input(), { key: 'Enter' })
  expect(count()).toBe('1 of 2')
  fireEvent.keyDown(input(), { key: 'Enter', shiftKey: true })
  expect(count()).toBe('2 of 2')
})

test('the next and previous buttons do the same and are disabled with nothing to step to', () => {
  renderBar()
  expect(screen.getByLabelText('Next match')).toBeDisabled()
  fireEvent.change(input(), { target: { value: 'alpha' } })
  fireEvent.click(screen.getByLabelText('Next match'))
  expect(count()).toBe('2 of 2')
  fireEvent.click(screen.getByLabelText('Previous match'))
  expect(count()).toBe('1 of 2')
})

test('a query with no matches says so rather than reporting a position', () => {
  renderBar()
  fireEvent.change(input(), { target: { value: 'not here' } })
  expect(count()).toBe('No results')
  expect(screen.getByLabelText('Next match')).toBeDisabled()
})

test('a match cannot run across the gap between two blocks', () => {
  renderBar()
  // 'alpha beta' and 'Alpha gamma' are separate paragraphs; only a flattening without a separator
  // between them would join 'beta' to 'Alpha'.
  fireEvent.change(input(), { target: { value: 'betaalpha' } })
  expect(count()).toBe('No results')
})

test('content that changes under an open find bar is searched again', () => {
  renderBar()
  fireEvent.change(input(), { target: { value: 'alpha' } })
  expect(count()).toBe('1 of 2')
  fireEvent.click(screen.getByText('Append'))
  expect(count()).toBe('1 of 3')
})

test('Escape closes the find bar from the input and from the prose the reader clicked into', () => {
  const { onClose } = renderBar()
  fireEvent.keyDown(input(), { key: 'Escape' })
  expect(onClose).toHaveBeenCalledTimes(1)
  // Reading a match means clicking away from the bar; Escape has to keep working from there.
  fireEvent.keyDown(document.body, { key: 'Escape' })
  expect(onClose).toHaveBeenCalledTimes(2)
})

test('content that changes keeps the reader on the match they had reached', () => {
  renderBar()
  fireEvent.change(input(), { target: { value: 'alpha' } })
  fireEvent.keyDown(input(), { key: 'Enter' })
  expect(count()).toBe('2 of 2')
  fireEvent.click(screen.getByText('Append'))
  expect(count()).toBe('2 of 3')
})

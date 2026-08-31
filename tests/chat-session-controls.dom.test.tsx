import { fireEvent, render, screen } from '@testing-library/react'
import { createRef } from 'react'
import { describe, expect, test, vi } from 'vitest'
import ChatSessionControls from '../src/renderer/src/ChatSessionControls'

describe('chat session controls', () => {
  test('owns both the focus button and its selected-node keyboard shortcut', () => {
    const setFocusMode = vi.fn()
    const rootRef = createRef<HTMLDivElement>()
    render(
      <div ref={rootRef}>
        <input aria-label="Composer" />
        <ChatSessionControls rootRef={rootRef} focusMode={false} setFocusMode={setFocusMode} focusShortcutEnabled />
      </div>
    )
    fireEvent.click(screen.getByRole('button', { name: 'Focus' }))
    expect(setFocusMode).toHaveBeenLastCalledWith(true)

    screen.getByRole('textbox', { name: 'Composer' }).focus()
    fireEvent.keyDown(window, { key: 'f', ctrlKey: true, shiftKey: true })
    expect(setFocusMode).toHaveBeenLastCalledWith(true)
    expect(setFocusMode).toHaveBeenCalledTimes(2)
  })
})

import { afterEach, describe, expect, test, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { TestChatView as ChatView } from './dom/chat-view-fixture'
import { useAgentConversation } from '../src/renderer/src/use-agent-conversation'
import { createMockAgentApi } from './dom/agent-api-mock'

// The canvas only zooms on a Ctrl-held wheel (see App.tsx's ReactFlow props), so a plain wheel over
// a chat node is already the node's own to scroll with. The composer used to swallow the gesture
// with a native listener while it had travel left; that listener would now hide a Ctrl+wheel from
// d3-zoom too, leaving a grown draft as a spot where the canvas refuses to zoom. Asserted through
// real bubbling, because the whole question is which listener gets to see the event.
// `tests/chat-node-wheel.test.ts` holds the same line for the static `nowheel` class.

function Harness(props: { id: string }): JSX.Element {
  const conversation = useAgentConversation({
    id: props.id,
    provider: 'claude',
    cwd: '/project',
    enabled: true,
    onSessionId: vi.fn(),
    onPermissionMode: vi.fn(),
    onModel: vi.fn()
  })
  return <ChatView {...conversation} provider="claude" focusMode={false} setFocusMode={vi.fn()} />
}

async function renderComposer(id: string): Promise<HTMLTextAreaElement> {
  window.agentApi = createMockAgentApi({
    create: vi.fn(async () => ({ ok: true, status: 'ready' as const, imageSupport: false }))
  }).api
  render(<Harness id={id} />)
  const textarea = await screen.findByPlaceholderText(/message the agent/i)
  await waitFor(() => expect(textarea).toBeEnabled())
  return textarea as HTMLTextAreaElement
}

/**
 * jsdom has no layout, so the geometry the removed listener used to read has to be stated outright.
 * A grown, scrollable box is the case that used to swallow the wheel, and so the only one worth
 * rendering: with the listener gone there is no longer a second path for a short draft to take.
 */
function growComposer(element: HTMLElement): void {
  const geometry = { scrollTop: 40, scrollHeight: 400, clientHeight: 168 }
  for (const [key, value] of Object.entries(geometry)) {
    Object.defineProperty(element, key, { configurable: true, value })
  }
}

let stopWatching: (() => void) | undefined

/** Stands in for d3-zoom's listener on the pane above the node: whatever reaches it is what zooms. */
function watchCanvasWheel(): ReturnType<typeof vi.fn> {
  const canvas = vi.fn()
  document.body.addEventListener('wheel', canvas)
  stopWatching = () => document.body.removeEventListener('wheel', canvas)
  return canvas
}

afterEach(() => {
  stopWatching?.()
  stopWatching = undefined
})

describe('chat node wheel', () => {
  test('a Ctrl+wheel over a scrollable composer reaches the canvas, so the zoom still happens', async () => {
    const textarea = await renderComposer('wheel-ctrl')
    growComposer(textarea)
    const canvas = watchCanvasWheel()

    fireEvent.wheel(textarea, { deltaY: -30, ctrlKey: true, bubbles: true })

    expect(canvas).toHaveBeenCalledTimes(1)
  })

  test('a plain wheel over a scrollable composer reaches the canvas in both directions', async () => {
    const textarea = await renderComposer('wheel-plain')
    growComposer(textarea)
    const canvas = watchCanvasWheel()

    fireEvent.wheel(textarea, { deltaY: 30, bubbles: true })
    fireEvent.wheel(textarea, { deltaY: -30, bubbles: true })

    expect(canvas).toHaveBeenCalledTimes(2)
  })

  // Nothing in a chat node may cancel a plain wheel either: the scroll it would cancel is the one
  // the canvas handed the node by refusing to zoom on anything but Ctrl.
  test('a plain wheel is left to scroll the composer', async () => {
    const textarea = await renderComposer('wheel-not-cancelled')
    growComposer(textarea)

    const delivered = fireEvent.wheel(textarea, { deltaY: 30, bubbles: true, cancelable: true })

    expect(delivered).toBe(true)
  })

  test('the transcript does not opt itself out of the canvas wheel', async () => {
    await renderComposer('wheel-transcript')
    const scroll = document.querySelector('.chat-scroll')

    expect(scroll).not.toBeNull()
    expect(scroll?.classList.contains('nowheel')).toBe(false)
  })
})

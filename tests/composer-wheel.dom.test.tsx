import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import { TestChatView as ChatView } from './dom/chat-view-fixture'
import { useAgentConversation } from '../src/renderer/src/use-agent-conversation'
import { createMockAgentApi } from './dom/agent-api-mock'

// The composer sits on a React Flow canvas that zooms on every wheel event reaching it. A grown,
// scrollable composer must keep the gesture for itself; a resting one must let it through so the
// canvas still zooms. Asserted through real bubbling, because the whole fix is about which
// listener sees the event. See use-prompt-editor.ts's wheel effect and composer-autosize.ts.

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

/** jsdom has no layout, so the scroll geometry the listener reads has to be stated outright. */
function giveScrollGeometry(
  element: HTMLElement,
  geometry: { scrollTop: number; scrollHeight: number; clientHeight: number }
): void {
  for (const [key, value] of Object.entries(geometry)) {
    Object.defineProperty(element, key, { configurable: true, value })
  }
}

describe('composer wheel', () => {
  test('a wheel over a scrollable composer scrolls the composer instead of reaching the canvas', async () => {
    const textarea = await renderComposer('wheel-scrollable')
    giveScrollGeometry(textarea, { scrollTop: 40, scrollHeight: 400, clientHeight: 168 })
    const canvas = vi.fn()
    document.body.addEventListener('wheel', canvas)

    fireEvent.wheel(textarea, { deltaY: 30, bubbles: true })
    fireEvent.wheel(textarea, { deltaY: -30, bubbles: true })

    expect(canvas).not.toHaveBeenCalled()
    document.body.removeEventListener('wheel', canvas)
  })

  test('a wheel over a composer with nothing to scroll is left to the canvas', async () => {
    const textarea = await renderComposer('wheel-resting')
    giveScrollGeometry(textarea, { scrollTop: 0, scrollHeight: 46, clientHeight: 46 })
    const canvas = vi.fn()
    document.body.addEventListener('wheel', canvas)

    fireEvent.wheel(textarea, { deltaY: 30, bubbles: true })

    expect(canvas).toHaveBeenCalledTimes(1)
    document.body.removeEventListener('wheel', canvas)
  })

  // Releasing the gesture once the composer runs out of travel let d3-zoom pick up the tail of a
  // real scroll and zoom the canvas out from under a long draft, so a scrollable composer holds the
  // wheel at both ends of its travel.
  test('a composer scrolled to its end keeps the wheel in both directions', async () => {
    const textarea = await renderComposer('wheel-at-end')
    giveScrollGeometry(textarea, { scrollTop: 232, scrollHeight: 400, clientHeight: 168 })
    const canvas = vi.fn()
    document.body.addEventListener('wheel', canvas)

    fireEvent.wheel(textarea, { deltaY: 30, bubbles: true })
    fireEvent.wheel(textarea, { deltaY: -30, bubbles: true })

    expect(canvas).not.toHaveBeenCalled()
    document.body.removeEventListener('wheel', canvas)
  })
})

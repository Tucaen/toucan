import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import { TestChatView as ChatView } from './dom/chat-view-fixture'
import { useAgentConversation } from '../src/renderer/src/use-agent-conversation'
import { createMockAgentApi } from './dom/agent-api-mock'

// A pasted screenshot must not vanish when the message is sent: the sent user message keeps its
// own thumbnails, and clicking one opens the full-size viewer. See ChatNode.tsx's
// ChatMessageCard/ImageAttachmentViewer and use-agent-conversation.ts's dispatchText.

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

function pasteImageItem(file: File): { items: Array<{ kind: string; type: string; getAsFile(): File }> } {
  return { items: [{ kind: 'file', type: file.type, getAsFile: () => file }] }
}

async function renderReadyHarness(id: string): Promise<ReturnType<typeof createMockAgentApi>> {
  const mock = createMockAgentApi({
    create: vi.fn(async () => ({ ok: true, status: 'ready' as const, imageSupport: true }))
  })
  window.agentApi = mock.api
  render(<Harness id={id} />)
  const textarea = await screen.findByPlaceholderText(/message the agent/i)
  await waitFor(() => expect(textarea).toBeEnabled())
  return mock
}

async function pasteAndSend(id: string, text: string, files: File[]): Promise<void> {
  await renderReadyHarness(id)
  const textarea = screen.getByPlaceholderText(/message the agent/i)
  for (const file of files) {
    fireEvent.paste(textarea, { clipboardData: pasteImageItem(file) })
    await waitFor(() => expect(screen.getAllByAltText('Pasted attachment').length).toBeGreaterThan(0))
  }
  await waitFor(() => expect(screen.getAllByAltText('Pasted attachment')).toHaveLength(files.length))
  if (text) fireEvent.change(textarea, { target: { value: text } })
  fireEvent.click(screen.getByRole('button', { name: 'Send' }))
}

describe('sent message attachments', () => {
  test('a sent message keeps the pasted image as a thumbnail on the message itself', async () => {
    await pasteAndSend('sent-attachment-session', 'look at this', [
      new File(['png-bytes'], 'clip.png', { type: 'image/png' })
    ])

    const thumbnail = await screen.findByAltText('Attached image 1')
    expect(thumbnail).toBeInTheDocument()
    expect((thumbnail as HTMLImageElement).src).toContain(
      `data:image/png;base64,${Buffer.from('png-bytes').toString('base64')}`
    )
    // The message bubble - not the composer - is what carries it now.
    expect(screen.queryByAltText('Pasted attachment')).toBeNull()
    expect(thumbnail.closest('.chat-message.user')).not.toBeNull()
  })

  test('an image-only send shows the image rather than an "1 image attached" placeholder', async () => {
    await pasteAndSend('image-only-attachment-session', '', [new File(['solo'], 'solo.png', { type: 'image/png' })])

    expect(await screen.findByAltText('Attached image 1')).toBeInTheDocument()
    expect(screen.queryByText(/1 image attached/i)).toBeNull()
  })

  test('every attached image on a message gets its own thumbnail', async () => {
    await pasteAndSend('multi-attachment-session', 'both please', [
      new File(['one'], 'one.png', { type: 'image/png' }),
      new File(['two'], 'two.png', { type: 'image/png' })
    ])

    expect(await screen.findByAltText('Attached image 1')).toBeInTheDocument()
    expect(screen.getByAltText('Attached image 2')).toBeInTheDocument()
  })
})

describe('queued attachments', () => {
  test('an image attached to a prompt queued while the agent is busy stays visible in the outbox', async () => {
    const mock = await renderReadyHarness('queued-attachment-session')
    // A never-settling prompt keeps the session 'working', so the next submit parks in the outbox.
    mock.api.prompt.mockImplementation(() => new Promise(() => {}))
    const textarea = screen.getByPlaceholderText(/message the agent/i)
    fireEvent.change(textarea, { target: { value: 'first' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    fireEvent.paste(textarea, { clipboardData: pasteImageItem(new File(['queued'], 'q.png', { type: 'image/png' })) })
    await screen.findByAltText('Pasted attachment')
    // While a turn is running the send button queues instead of dispatching.
    fireEvent.click(await screen.findByRole('button', { name: 'Queue' }))

    await screen.findByRole('list', { name: 'Queued messages' })
    const thumbnail = await screen.findByAltText('Attached image 1')
    expect(thumbnail.closest('.queued-prompt')).not.toBeNull()
  })
})

describe('attachment viewer', () => {
  test('clicking a thumbnail opens a full-size viewer, and Escape closes it', async () => {
    await pasteAndSend('viewer-session', 'see this', [new File(['png-bytes'], 'clip.png', { type: 'image/png' })])

    fireEvent.click(await screen.findByRole('button', { name: 'View attached image 1' }))

    const viewer = await screen.findByRole('dialog', { name: /attached image/i })
    expect(viewer).toBeInTheDocument()
    const full = screen.getByAltText('Attached image 1, full size')
    expect((full as HTMLImageElement).src).toContain('data:image/png;base64,')

    // Escape is handled on the dialog itself: a portal's events bubble through the React tree,
    // so the chat node must not also see it.
    fireEvent.keyDown(viewer, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /attached image/i })).toBeNull())
  })

  test("the viewer walks between a message's images and can be dismissed with its close button", async () => {
    await pasteAndSend('viewer-multi-session', 'two of them', [
      new File(['one'], 'one.png', { type: 'image/png' }),
      new File(['two'], 'two.png', { type: 'image/png' })
    ])

    fireEvent.click(await screen.findByRole('button', { name: 'View attached image 1' }))
    await screen.findByAltText('Attached image 1, full size')

    fireEvent.click(screen.getByRole('button', { name: 'Next image' }))
    expect(await screen.findByAltText('Attached image 2, full size')).toBeInTheDocument()
    expect(screen.getByText('2 of 2')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Previous image' }))
    expect(await screen.findByAltText('Attached image 1, full size')).toBeInTheDocument()

    // Focus is inside the dialog on open, which is what makes the arrow keys reachable at all.
    const viewer = screen.getByRole('dialog', { name: /attached image/i })
    expect(document.activeElement).toBe(viewer)
    fireEvent.keyDown(viewer, { key: 'ArrowRight' })
    expect(await screen.findByAltText('Attached image 2, full size')).toBeInTheDocument()
    fireEvent.keyDown(viewer, { key: 'ArrowLeft' })
    expect(await screen.findByAltText('Attached image 1, full size')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Close image viewer' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /attached image/i })).toBeNull())
  })

  test('closing the viewer returns focus to the thumbnail that opened it', async () => {
    await pasteAndSend('viewer-focus-session', 'focus me', [new File(['one'], 'one.png', { type: 'image/png' })])

    const thumbnail = await screen.findByRole('button', { name: 'View attached image 1' })
    fireEvent.click(thumbnail)
    await screen.findByAltText('Attached image 1, full size')

    fireEvent.click(screen.getByRole('button', { name: 'Close image viewer' }))
    await waitFor(() => expect(document.activeElement).toBe(thumbnail))
  })

  test('a single-image viewer offers no navigation controls', async () => {
    await pasteAndSend('viewer-single-session', 'only one', [new File(['one'], 'one.png', { type: 'image/png' })])

    fireEvent.click(await screen.findByRole('button', { name: 'View attached image 1' }))
    await screen.findByAltText('Attached image 1, full size')

    expect(screen.queryByRole('button', { name: 'Next image' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Previous image' })).toBeNull()
  })
})

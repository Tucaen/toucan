import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import { ChatView } from '../src/renderer/src/ChatNode'
import { useAgentConversation } from '../src/renderer/src/use-agent-conversation'
import { createMockAgentApi } from './dom/agent-api-mock'

// Exercises the paste-to-attach composer flow end to end: a real `paste` DOM event carrying an
// `image/*` clipboard item flows through useAgentConversation's addImages into a rendered
// thumbnail, and submitting builds the ACP text+image content-block array the agent receives.
// See ChatNode.tsx's Composer/AttachmentPreview and use-agent-conversation.ts's addImages/submit.

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
  return (
    <ChatView
      {...conversation}
      provider="claude"
      focusMode={false}
      setFocusMode={vi.fn()}
    />
  )
}

function pasteImageItem(file: File): { items: Array<{ kind: string; type: string; getAsFile(): File }> } {
  return { items: [{ kind: 'file', type: file.type, getAsFile: () => file }] }
}

async function renderReadyHarness(id: string, imageSupport: boolean): Promise<ReturnType<typeof createMockAgentApi>> {
  const mock = createMockAgentApi({
    create: vi.fn(async () => ({ ok: true, status: 'ready' as const, imageSupport }))
  })
  window.agentApi = mock.api
  render(<Harness id={id} />)
  const textarea = await screen.findByPlaceholderText(/message the agent/i)
  await waitFor(() => expect(textarea).toBeEnabled())
  return mock
}

describe('paste-to-attach', () => {
  test('pasting a clipboard image attaches a removable thumbnail preview instead of sending it invisibly', async () => {
    await renderReadyHarness('paste-session', true)
    const textarea = screen.getByPlaceholderText(/message the agent/i)
    const file = new File(['fake-png-bytes'], 'clipboard.png', { type: 'image/png' })

    fireEvent.paste(textarea, { clipboardData: pasteImageItem(file) })

    const thumbnail = await screen.findByAltText('Pasted attachment')
    expect(thumbnail).toBeInTheDocument()
    expect((thumbnail as HTMLImageElement).src).toContain('data:image/png;base64,')

    fireEvent.click(screen.getByRole('button', { name: 'Remove attached image' }))
    await waitFor(() => expect(screen.queryByAltText('Pasted attachment')).toBeNull())
  })

  test('pasting more than one image attaches a thumbnail for each, in sequence', async () => {
    await renderReadyHarness('paste-multi-session', true)
    const textarea = screen.getByPlaceholderText(/message the agent/i)

    fireEvent.paste(textarea, { clipboardData: pasteImageItem(new File(['one'], 'one.png', { type: 'image/png' })) })
    await screen.findAllByAltText('Pasted attachment')
    fireEvent.paste(textarea, { clipboardData: pasteImageItem(new File(['two'], 'two.png', { type: 'image/png' })) })

    await waitFor(() => expect(screen.getAllByAltText('Pasted attachment')).toHaveLength(2))
  })

  test('submitting a pasted image alongside typed text sends both as ACP text + image content blocks', async () => {
    const mock = await renderReadyHarness('content-block-session', true)
    const textarea = screen.getByPlaceholderText(/message the agent/i)
    const bytes = 'fake-png-bytes'

    fireEvent.paste(textarea, { clipboardData: pasteImageItem(new File([bytes], 'clipboard.png', { type: 'image/png' })) })
    await screen.findByAltText('Pasted attachment')

    fireEvent.change(textarea, { target: { value: 'look at this' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    await waitFor(() => expect(mock.api.prompt).toHaveBeenCalled())
    expect(mock.api.prompt).toHaveBeenCalledWith('content-block-session', [
      { type: 'text', text: 'look at this' },
      { type: 'image', data: Buffer.from(bytes).toString('base64'), mimeType: 'image/png' }
    ])

    // The composer clears its attachments once the message is sent.
    expect(screen.queryByAltText('Pasted attachment')).toBeNull()
  })

  test('an image-only submission (no typed text) still sends a single image content block', async () => {
    const mock = await renderReadyHarness('image-only-session', true)
    const textarea = screen.getByPlaceholderText(/message the agent/i)
    const bytes = 'solo-image-bytes'

    fireEvent.paste(textarea, { clipboardData: pasteImageItem(new File([bytes], 'solo.png', { type: 'image/png' })) })
    await screen.findByAltText('Pasted attachment')

    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    await waitFor(() => expect(mock.api.prompt).toHaveBeenCalled())
    expect(mock.api.prompt).toHaveBeenCalledWith('image-only-session', [
      { type: 'image', data: Buffer.from(bytes).toString('base64'), mimeType: 'image/png' }
    ])
  })
})

describe('image capability gating', () => {
  test(
    'pasting an image when the active agent does not advertise image support shows an inline '
    + 'message instead of silently attaching (or sending) it',
    async () => {
      await renderReadyHarness('no-image-support-session', false)
      const textarea = screen.getByPlaceholderText(/message the agent/i)

      fireEvent.paste(textarea, {
        clipboardData: pasteImageItem(new File(['bytes'], 'clip.png', { type: 'image/png' }))
      })

      expect(await screen.findByText(/doesn't support image attachments/i)).toBeInTheDocument()
      expect(screen.queryByAltText('Pasted attachment')).toBeNull()
    }
  )

  test('a non-image clipboard paste (plain text) is unaffected by the image-support gate', async () => {
    await renderReadyHarness('text-paste-session', false)
    const textarea = screen.getByPlaceholderText(/message the agent/i)

    fireEvent.paste(textarea, { clipboardData: { items: [] } })

    expect(screen.queryByText(/doesn't support image attachments/i)).toBeNull()
    expect(screen.queryByAltText('Pasted attachment')).toBeNull()
  })
})

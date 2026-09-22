import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import { TestChatView as ChatView, type TestChatViewProps as ChatViewProps } from './dom/chat-view-fixture'
import type { AgentActivity } from '../src/shared/agent'
import type { AgentChatMessage } from '../src/shared/agent-transcript'

// Issue #174: a successful image generation showed its revised prompt and a DONE state with no
// picture anywhere. The image is ordinary ACP `image` content, and every reader flattened content
// to text - so these cover the whole way out: the card renders it, a completed card does not hide
// it behind its own collapse, ordering survives, and an image that cannot be painted says why.

const baseChatViewProps: ChatViewProps = {
  provider: 'claude',
  messages: [],
  activities: [],
  plan: [],
  approval: null,
  authMethods: [],
  authLink: null,
  reauthenticating: false,
  status: 'ready',
  draft: '',
  imageSupport: false,
  attachments: [],
  addImages: vi.fn(),
  removeAttachment: vi.fn(),
  submit: vi.fn(),
  cancel: vi.fn(),
  authenticate: vi.fn(),
  openAuthLink: vi.fn(),
  resolveApproval: vi.fn(),
  sendMessage: vi.fn(),
  answerDecision: vi.fn(),
  queued: [],
  editQueued: vi.fn(),
  withdrawQueued: vi.fn(),
  sendQueuedNow: vi.fn()
}

function renderChat(props: Partial<ChatViewProps>): HTMLElement {
  const { container } = render(<ChatView {...baseChatViewProps} {...props} focusMode={false} setFocusMode={vi.fn()} />)
  return container
}

const FIRST = Buffer.from('first-png').toString('base64')
const SECOND = Buffer.from('second-png').toString('base64')

function generation(images: AgentActivity['images']): AgentActivity {
  return {
    id: 'image-1',
    title: 'Image generation',
    kind: 'other',
    status: 'completed',
    content: 'Revised prompt: a dwarf in half-plate.',
    startedAt: 1000,
    endedAt: 63_000,
    images
  }
}

describe('a tool call that produced images', () => {
  test('the picture is on the card, beside the prompt metadata, without expanding anything', () => {
    const container = renderChat({
      activities: [generation([{ id: 'image-1#0', data: FIRST, mimeType: 'image/png' }])]
    })

    // A completed card collapses its body; the image must not be collapsed with it, or a finished
    // generation reads exactly as the bug did.
    const card = container.querySelector<HTMLElement>('.activity-card')!
    expect(card.dataset.expanded).toBe('false')
    const thumbnail = within(card).getByAltText('Generated image 1') as HTMLImageElement
    expect(thumbnail.src).toBe(`data:image/png;base64,${FIRST}`)
    expect(within(card).getByText(/Image generation/)).toBeInTheDocument()
  })

  test('several images keep the order the agent produced them in, and none is dropped', () => {
    const container = renderChat({
      activities: [
        generation([
          { id: 'image-1#0', data: FIRST, mimeType: 'image/png' },
          { id: 'image-1#1', data: SECOND, mimeType: 'image/png' }
        ])
      ]
    })

    const sources = [...container.querySelectorAll<HTMLImageElement>('.activity-card .message-attachment img')].map(
      (image) => image.src
    )
    expect(sources).toEqual([`data:image/png;base64,${FIRST}`, `data:image/png;base64,${SECOND}`])
  })

  test('an image with no bytes explains itself rather than leaving a completed card with nothing', () => {
    const container = renderChat({
      activities: [generation([{ id: 'image-1#0', data: '', mimeType: '', uri: 'https://example.test/a.png' }])]
    })

    expect(container.querySelector('.activity-card .message-attachment')).toBeNull()
    expect(
      within(container.querySelector<HTMLElement>('.activity-card')!).getByText(
        'The image was not included in the reply. It lives at https://example.test/a.png.'
      )
    ).toBeInTheDocument()
  })

  test('a type the browser cannot decode is named instead of rendered as a broken frame', () => {
    const container = renderChat({
      activities: [generation([{ id: 'image-1#0', data: FIRST, mimeType: 'image/heic' }])]
    })

    expect(container.querySelector('.activity-card .message-attachment')).toBeNull()
    expect(screen.getByText(/Toucan cannot display image\/heic/)).toBeInTheDocument()
  })

  // The note tells the reader to save it and open it elsewhere, so the save has to be reachable
  // from the note: there is no thumbnail to enlarge, and a sentence naming an action nothing
  // offers is its own kind of silence.
  test('an undecodable image can still be saved, which is what its note tells the reader to do', async () => {
    const saveImage = vi.fn(async () => ({ status: 'saved' as const, path: 'D:\\pictures\\out.heic' }))
    window.shellApi = { saveImage } as unknown as typeof window.shellApi
    renderChat({ activities: [generation([{ id: 'image-1#0', data: FIRST, mimeType: 'image/heic' }])] })

    fireEvent.click(screen.getByRole('button', { name: 'Save image' }))

    expect(saveImage).toHaveBeenCalledWith({
      data: FIRST,
      mimeType: 'image/heic',
      suggestedName: 'generated-image-1'
    })
    expect(await screen.findByText('Saved to D:\\pictures\\out.heic')).toBeInTheDocument()
  })

  test('an image that cannot be painted keeps its slot number, so the rest are not renumbered', () => {
    renderChat({
      activities: [
        generation([
          { id: 'image-1#0', data: FIRST, mimeType: 'image/heic' },
          { id: 'image-1#1', data: SECOND, mimeType: 'image/png' }
        ])
      ]
    })

    // The painted one is the second image the agent produced and must say so.
    expect(screen.getByAltText('Generated image 2')).toBeInTheDocument()
    expect(screen.queryByAltText('Generated image 1')).toBeNull()
  })

  test('the enlarged view saves the bytes the transcript holds, and reports where they went', async () => {
    const saveImage = vi.fn(async () => ({ status: 'saved' as const, path: 'D:\\pictures\\dwarf.png' }))
    window.shellApi = { saveImage } as unknown as typeof window.shellApi
    renderChat({ activities: [generation([{ id: 'image-1#0', data: FIRST, mimeType: 'image/png' }])] })

    fireEvent.click(screen.getByRole('button', { name: 'View generated image 1' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Save image' }))

    expect(saveImage).toHaveBeenCalledWith({
      data: FIRST,
      mimeType: 'image/png',
      suggestedName: 'generated-image-1'
    })
    expect(await screen.findByText('Saved to D:\\pictures\\dwarf.png')).toBeInTheDocument()
  })

  test('a refused save says so beside the button, so the click is never a silent no-op', async () => {
    window.shellApi = {
      saveImage: vi.fn(async () => ({ status: 'refused' as const, message: 'EACCES: permission denied' }))
    } as unknown as typeof window.shellApi
    renderChat({ activities: [generation([{ id: 'image-1#0', data: FIRST, mimeType: 'image/png' }])] })

    fireEvent.click(screen.getByRole('button', { name: 'View generated image 1' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Save image' }))

    expect(await screen.findByText('EACCES: permission denied')).toBeInTheDocument()
  })
})

describe('an assistant message that carries its own image', () => {
  test('the picture renders on the message, in the position the prose put it', () => {
    const message: AgentChatMessage = {
      id: 'answer-1',
      role: 'assistant',
      text: 'Here is the comparison.',
      images: [{ id: 'answer-1#0', data: FIRST, mimeType: 'image/png' }],
      complete: true
    }
    const container = renderChat({ messages: [message] })

    const bubble = container.querySelector<HTMLElement>('.chat-message.assistant')!
    expect(within(bubble).getByText('Here is the comparison.')).toBeInTheDocument()
    expect((within(bubble).getByAltText('Attached image 1') as HTMLImageElement).src).toBe(
      `data:image/png;base64,${FIRST}`
    )
  })
})

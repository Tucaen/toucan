import { ReactFlowProvider } from '@xyflow/react'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, test, vi } from 'vitest'
import type { WorkspaceState } from '../src/shared/workspace'
import { localDateTimeInputValue, type ScheduledMessage } from '../src/shared/scheduled-message'
import ChatNode from '../src/renderer/src/ChatNode'
import {
  isTerminalCanvasNode,
  restoreCanvasWorkspace,
  type TerminalCanvasNode,
  type TerminalNodeCallbacks,
  type TerminalNodeData
} from '../src/renderer/src/canvas-workspace'
import { createMockAgentApi } from './dom/agent-api-mock'

// Issue #21 end to end through a real chat node: the clock beside dictate and send, its dialog,
// what scheduling captures from the composer, and the list above it. The node's data is held in
// state here the way App holds it, so persistence callbacks round-trip back down as props.

const callbacks: TerminalNodeCallbacks = {
  onStatusChange: vi.fn(),
  onConversationId: vi.fn(),
  onTitleChange: vi.fn(async () => true),
  onFocusModeChange: vi.fn(),
  onDraftChange: vi.fn(),
  onPermissionModeChange: vi.fn(),
  onModelChange: vi.fn(),
  onResume: vi.fn()
}

function restoredNode(scheduledMessages?: ScheduledMessage[]): TerminalCanvasNode {
  const state: WorkspaceState = {
    version: 3,
    projects: [{ id: 'project-1', name: 'Toucan', path: '/project', color: '#71a9ff' }],
    activeProjectId: 'project-1',
    sidebarCollapsed: false,
    nodes: [
      {
        id: 'chat-node',
        kind: 'claude',
        label: 'Claude 1',
        projectId: 'project-1',
        position: { x: 0, y: 0 },
        width: 640,
        height: 480,
        focusMode: false,
        ...(scheduledMessages ? { scheduledMessages } : {})
      }
    ],
    worktrees: []
  }
  const node = restoreCanvasWorkspace(state, callbacks).nodes.find(isTerminalCanvasNode)
  if (!node) throw new Error('Expected the saved chat node to restore.')
  return node
}

let persisted: ScheduledMessage[] | undefined

function Node(props: { node: TerminalCanvasNode }): JSX.Element {
  const [data, setData] = useState<TerminalNodeData>(props.node.data)
  const patch = (next: Partial<TerminalNodeData>): void => setData((current) => ({ ...current, ...next }))
  return (
    <ReactFlowProvider>
      <ChatNode
        id={props.node.id}
        data={{
          ...data,
          onDraftChange: (_id, draft) => patch({ draft }),
          onScheduledMessagesChange: (_id, scheduledMessages) => {
            persisted = scheduledMessages
            patch({ scheduledMessages })
          }
        }}
        type="terminalNode"
        dragging={false}
        zIndex={0}
        selectable
        deletable
        selected={false}
        width={640}
        draggable
        isConnectable={false}
        positionAbsoluteX={0}
        positionAbsoluteY={0}
      />
    </ReactFlowProvider>
  )
}

async function renderReadyNode(scheduledMessages?: ScheduledMessage[]): Promise<ReturnType<typeof createMockAgentApi>> {
  persisted = undefined
  const agent = createMockAgentApi({
    create: vi.fn(async () => ({ ok: true, status: 'ready' as const, imageSupport: true }))
  })
  window.agentApi = agent.api
  render(<Node node={restoredNode(scheduledMessages)} />)
  await waitFor(() => expect(screen.getByText('ready')).toBeInTheDocument())
  return agent
}

const composerTextarea = (): HTMLElement => screen.getByPlaceholderText(/message the agent/i)
const scheduleButton = (): HTMLElement => screen.getByRole('button', { name: 'Schedule message' })

function pasteImage(file: File): void {
  fireEvent.paste(composerTextarea(), {
    clipboardData: { items: [{ kind: 'file', type: file.type, getAsFile: () => file }] }
  })
}

function openScheduleDialog(): HTMLElement {
  fireEvent.click(scheduleButton())
  return screen.getByRole('dialog', { name: 'Schedule message' })
}

function setDeliveryTime(dialog: HTMLElement, time: number): void {
  fireEvent.change(within(dialog).getByLabelText('Deliver at'), { target: { value: localDateTimeInputValue(time) } })
}

describe('the scheduling control', () => {
  test('sits beside dictate and send, and waits for something to schedule', async () => {
    await renderReadyNode()
    const actions = scheduleButton().closest('.composer-actions')

    expect(actions).not.toBeNull()
    expect(within(actions as HTMLElement).getByRole('button', { name: 'Send' })).toBeInTheDocument()
    expect(within(actions as HTMLElement).getByRole('button', { name: /dictat/i })).toBeInTheDocument()
    expect(scheduleButton()).toBeDisabled()

    fireEvent.change(composerTextarea(), { target: { value: 'later please' } })
    expect(scheduleButton()).toBeEnabled()
  })

  test('opens an accessible dialog for a local date and time, and Escape closes it', async () => {
    await renderReadyNode()
    fireEvent.change(composerTextarea(), { target: { value: 'later please' } })

    const dialog = openScheduleDialog()
    const field = within(dialog).getByLabelText('Deliver at')
    expect(scheduleButton()).toHaveAttribute('aria-expanded', 'true')
    expect(scheduleButton()).toHaveAttribute('aria-controls', dialog.id)
    expect(field).toHaveAttribute('type', 'datetime-local')
    expect(field).toHaveFocus()

    fireEvent.keyDown(field, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(scheduleButton()).toHaveFocus()
    expect(composerTextarea()).toHaveValue('later please')
  })

  test('portals out of the clipping node, and closes once focus leaves it', async () => {
    await renderReadyNode()
    fireEvent.change(composerTextarea(), { target: { value: 'later please' } })

    const dialog = openScheduleDialog()
    expect(dialog.closest('.terminal-node')).toBeNull()
    expect(dialog.parentElement).toBe(document.body)

    fireEvent.blur(within(dialog).getByLabelText('Deliver at'), { relatedTarget: composerTextarea() })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  test('refuses a time in the past and keeps the composer as it was', async () => {
    const agent = await renderReadyNode()
    fireEvent.change(composerTextarea(), { target: { value: 'too late' } })

    const dialog = openScheduleDialog()
    setDeliveryTime(dialog, Date.now() - 60 * 60 * 1000)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Schedule' }))

    expect(within(dialog).getByRole('alert')).toHaveTextContent(/future/i)
    expect(within(dialog).getByLabelText('Deliver at')).toHaveAttribute('aria-invalid', 'true')
    expect(composerTextarea()).toHaveValue('too late')
    expect(persisted).toBeUndefined()
    expect(agent.api.prompt).not.toHaveBeenCalled()
  })

  test('captures the text and every attachment, clears them, and lists the message with its time', async () => {
    const agent = await renderReadyNode()
    pasteImage(new File(['one'], 'one.png', { type: 'image/png' }))
    pasteImage(new File(['two'], 'two.png', { type: 'image/png' }))
    await waitFor(() => expect(screen.getAllByAltText('Pasted attachment')).toHaveLength(2))
    fireEvent.change(composerTextarea(), { target: { value: 'review these tomorrow' } })

    const deliverAt = new Date(Date.now() + 24 * 60 * 60 * 1000).setSeconds(0, 0)
    const dialog = openScheduleDialog()
    setDeliveryTime(dialog, deliverAt)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Schedule' }))

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(composerTextarea()).toHaveValue('')
    expect(screen.queryByAltText('Pasted attachment')).toBeNull()
    expect(persisted).toEqual([
      {
        id: expect.any(String),
        text: 'review these tomorrow',
        images: [
          expect.objectContaining({ mimeType: 'image/png' }),
          expect.objectContaining({ mimeType: 'image/png' })
        ],
        deliverAt
      }
    ])

    const list = screen.getByRole('list', { name: 'Scheduled messages' })
    const item = within(list).getByRole('listitem')
    expect(within(item).getByText('review these tomorrow')).toBeInTheDocument()
    expect(within(item).getAllByAltText(/attached image/i)).toHaveLength(2)
    expect(item.querySelector('time')).toHaveAttribute('dateTime', new Date(deliverAt).toISOString())
    expect(item.querySelector('time')).toHaveTextContent(
      `Scheduled for ${new Date(deliverAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}`
    )
    expect(agent.api.prompt).not.toHaveBeenCalled()
  })
})

describe('a waiting scheduled message', () => {
  const upcoming = (): ScheduledMessage => ({
    id: 'upcoming',
    text: 'run the nightly checks',
    images: [],
    deliverAt: new Date(Date.now() + 2 * 60 * 60 * 1000).setSeconds(0, 0)
  })

  test('can be sent immediately, through the ordinary prompt path', async () => {
    const agent = await renderReadyNode([upcoming()])
    fireEvent.click(screen.getByRole('button', { name: 'Send now' }))

    await waitFor(() => expect(agent.api.prompt).toHaveBeenCalledWith('chat-node', 'run the nightly checks'))
    expect(screen.queryByRole('list', { name: 'Scheduled messages' })).toBeNull()
    expect(persisted).toEqual([])
  })

  test('can be cancelled, and is then never sent', async () => {
    const agent = await renderReadyNode([upcoming()])
    fireEvent.click(screen.getByRole('button', { name: 'Cancel scheduled message' }))

    expect(screen.queryByRole('list', { name: 'Scheduled messages' })).toBeNull()
    expect(persisted).toEqual([])
    expect(agent.api.prompt).not.toHaveBeenCalled()
  })

  test('can have its text and time edited, and refuses a past time', async () => {
    await renderReadyNode([upcoming()])
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    const item = screen.getByRole('listitem')
    fireEvent.change(within(item).getByLabelText('Edit scheduled message'), { target: { value: 'run them twice' } })

    fireEvent.change(within(item).getByLabelText('Deliver at'), {
      target: { value: localDateTimeInputValue(Date.now() - 60 * 60 * 1000) }
    })
    fireEvent.click(within(item).getByRole('button', { name: 'Save' }))
    expect(within(item).getByRole('alert')).toHaveTextContent(/future/i)

    const later = new Date(Date.now() + 5 * 60 * 60 * 1000).setSeconds(0, 0)
    fireEvent.change(within(item).getByLabelText('Deliver at'), { target: { value: localDateTimeInputValue(later) } })
    fireEvent.click(within(item).getByRole('button', { name: 'Save' }))

    expect(persisted).toEqual([{ id: 'upcoming', text: 'run them twice', images: [], deliverAt: later }])
    expect(screen.getByText('run them twice')).toBeInTheDocument()
  })

  test('is delivered on its own when its time arrives while the node is open', async () => {
    // Faked before the node mounts, so the delivery timer it arms is one the test can move past.
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      await deliversWhenDue()
    } finally {
      vi.useRealTimers()
    }
  })

  async function deliversWhenDue(): Promise<void> {
    const agent = await renderReadyNode()
    fireEvent.change(composerTextarea(), { target: { value: 'any moment now' } })
    const dialog = openScheduleDialog()
    // The field has minute precision, so a time a few seconds out is entered through the next
    // minute and the clock is moved past it rather than waited on.
    const deliverAt = new Date(Date.now() + 60 * 1000).setSeconds(0, 0) + 60 * 1000
    setDeliveryTime(dialog, deliverAt)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Schedule' }))
    expect(persisted).toHaveLength(1)
    expect(agent.api.prompt).not.toHaveBeenCalled()

    await act(async () => {
      vi.setSystemTime(deliverAt + 1)
      await vi.advanceTimersByTimeAsync(3 * 60 * 1000)
    })
    await waitFor(() => expect(agent.api.prompt).toHaveBeenCalledWith('chat-node', 'any moment now'))
    expect(persisted).toEqual([])
  }
})

describe('after a restart', () => {
  test('a message whose time passed while Toucan was closed is overdue and is not sent on its own', async () => {
    const missed: ScheduledMessage = {
      id: 'missed',
      text: 'deploy at nine',
      images: [{ id: 'image-1', data: 'aGVsbG8=', mimeType: 'image/png' }],
      deliverAt: Date.now() - 60 * 60 * 1000
    }
    const agent = await renderReadyNode([missed])

    const item = within(screen.getByRole('list', { name: 'Scheduled messages' })).getByRole('listitem')
    expect(item).toHaveAttribute('data-overdue', 'true')
    expect(item.querySelector('time')).toHaveTextContent(/^Overdue - was due /)
    expect(screen.getByText(/will only be sent when you choose Send now/)).toBeInTheDocument()
    // Give any automatic delivery every chance to happen before asserting that it did not.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50))
    })
    expect(agent.api.prompt).not.toHaveBeenCalled()

    fireEvent.click(within(item).getByRole('button', { name: 'Send now' }))
    await waitFor(() =>
      expect(agent.api.prompt).toHaveBeenCalledWith('chat-node', [
        { type: 'text', text: 'deploy at nine' },
        { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }
      ])
    )
    expect(persisted).toEqual([])
  })
})

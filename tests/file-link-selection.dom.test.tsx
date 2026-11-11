import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { createMockAgentApi } from './dom/agent-api-mock'
import { DEFAULT_PROJECT, renderApp, savedWorkspace } from './dom/app-harness'

/**
 * Issue #2: a file link in a chat opens a file node, and closing that node must close only it.
 * The click that follows the link's own handler used to re-select the chat, leaving two nodes
 * selected, so Delete took both.
 */

const CHAT_ID = 'chat-1'
const FILE_PATH = 'D:\\Development\\Toucan\\docs\\plan.md'

afterEach(() => {
  Reflect.deleteProperty(window, 'fileViewApi')
})

const nodeById = (id: string): HTMLElement | null =>
  document.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"]`)
const fileNode = (): HTMLElement | null => document.querySelector<HTMLElement>('.react-flow__node-fileNode')
const isSelected = (node: HTMLElement | null): boolean => node?.classList.contains('selected') === true

async function mountChatWithFileLink(): Promise<void> {
  const mock = createMockAgentApi({
    create: vi.fn(async () => ({
      ok: true,
      status: 'ready' as const,
      sessionId: 'conversation-1',
      replay: [
        { type: 'message', role: 'assistant', messageId: 'a1', text: `See [the plan](<${FILE_PATH}>) for details.` }
      ]
    })) as never
  })
  Object.defineProperty(window, 'fileViewApi', {
    configurable: true,
    writable: true,
    value: {
      read: vi.fn(async () => ({
        ok: true,
        content: '# Plan',
        truncated: false,
        size: 6,
        mtime: '2026-09-05T09:00:00.000Z',
        binary: false
      })),
      write: vi.fn(),
      watch: vi.fn(async () => undefined),
      unwatch: vi.fn(async () => undefined),
      onChange: () => () => undefined
    }
  })
  await renderApp({
    state: savedWorkspace({
      nodes: [
        {
          id: CHAT_ID,
          kind: 'claude',
          label: 'Claude 1',
          projectId: DEFAULT_PROJECT.id,
          position: { x: 0, y: 0 },
          width: 640,
          height: 480,
          conversationId: 'conversation-1'
        }
      ]
    }),
    apis: { agentApi: mock.api as unknown as Record<string, unknown> }
  })
  await waitFor(() => expect(nodeById(CHAT_ID)).not.toBeNull())
}

describe('opening a file from a chat link (#2)', () => {
  test('selects only the new file node, and closing it leaves the chat', async () => {
    await mountChatWithFileLink()
    const link = await screen.findByText('the plan')
    // A real click is pointer down, up, then click, all bubbling through the chat's node wrapper.
    fireEvent.mouseDown(link)
    fireEvent.mouseUp(link)
    fireEvent.click(link)
    await waitFor(() => expect(fileNode()).not.toBeNull())
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50))
    })

    expect(isSelected(fileNode())).toBe(true)
    expect(isSelected(nodeById(CHAT_ID))).toBe(false)

    fireEvent.keyDown(document.body, { key: 'Delete', code: 'Delete' })
    await waitFor(() => expect(fileNode()).toBeNull())
    expect(nodeById(CHAT_ID)).not.toBeNull()
  })
})

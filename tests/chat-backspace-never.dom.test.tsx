import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { describe, expect, test } from 'vitest'
import { createMockAgentApi } from './dom/agent-api-mock'
import { DEFAULT_PROJECT, renderApp, savedWorkspace } from './dom/app-harness'

/**
 * Issue #2 through the real `App`: Backspace never removes a chat node, whatever has focus and
 * however long ago anyone typed; Delete (Entf) still does.
 */

const NODE_ID = 'chat-1'

async function mountSelectedChat(): Promise<void> {
  const mock = createMockAgentApi()
  await renderApp({
    state: savedWorkspace({
      nodes: [
        {
          id: NODE_ID,
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
  await waitFor(() => expect(chatNode()).not.toBeNull())
  fireEvent.click(chatNode()!.querySelector('.node-header') ?? chatNode()!)
  await screen.findByPlaceholderText('Message the agent...')
  ;(document.activeElement as HTMLElement | null)?.blur()
}

function chatNode(): HTMLElement | null {
  return document.querySelector<HTMLElement>(`.react-flow__node[data-id="${NODE_ID}"]`)
}

describe('Backspace never removes a chat (#2)', () => {
  test('Backspace on a selected chat, focus on the body and no typing before it, leaves it', async () => {
    await mountSelectedChat()
    fireEvent.keyDown(document.body, { key: 'Backspace', code: 'Backspace' })
    fireEvent.keyUp(document.body, { key: 'Backspace', code: 'Backspace' })
    // React Flow removes nodes asynchronously (onBeforeDelete is awaited), so give it its turn.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50))
    })
    expect(chatNode()).not.toBeNull()
  })

  test('Delete on the same selected chat still removes it', async () => {
    await mountSelectedChat()
    fireEvent.keyDown(document.body, { key: 'Delete', code: 'Delete' })
    await waitFor(() => expect(chatNode()).toBeNull())
  })
})

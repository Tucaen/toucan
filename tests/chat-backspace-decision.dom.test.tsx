import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { AgentEvent } from '../src/shared/agent'
import { createMockAgentApi, type MockAgentApi } from './dom/agent-api-mock'
import { DEFAULT_PROJECT, renderApp, savedWorkspace } from './dom/app-harness'

/**
 * Issue #1 through the real `App`: the captain is typing in a chat's composer, holds Backspace
 * over a typo, and the agent raises a structured decision. The panel replaces the composer, so the
 * focused textarea leaves the document and the remaining Backspace keydowns land on the body -
 * where the canvas's delete key (`deleteKeyCode`) used to close the selected chat. Intentional
 * deletes - no typing before them, or a pause after it - must still close the chat.
 */

const NODE_ID = 'chat-1'

const decision: AgentEvent = {
  type: 'decision_request',
  request: {
    id: 'elicit-1',
    message: 'Please answer the following questions.',
    questions: [
      {
        id: 'scope',
        title: 'Scope',
        question: 'Read-only first?',
        options: [{ value: 'yes', label: 'Yes' }],
        input: 'select',
        multiSelect: false
      }
    ]
  }
}

let mock: MockAgentApi

async function mountSelectedChat(): Promise<HTMLTextAreaElement> {
  mock = createMockAgentApi()
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
  const textarea = await screen.findByPlaceholderText('Message the agent...')
  textarea.focus()
  return textarea as HTMLTextAreaElement
}

function chatNode(): HTMLElement | null {
  return document.querySelector<HTMLElement>(`.react-flow__node[data-id="${NODE_ID}"]`)
}

describe('Backspace while a decision panel appears (#1)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  test('Backspace keys that outlive the focused composer never close the chat', async () => {
    const textarea = await mountSelectedChat()
    fireEvent.keyDown(textarea, { key: 'Backspace', code: 'Backspace' })

    await act(async () => {
      mock.emit(NODE_ID, decision)
    })
    await screen.findByText('Read-only first?')
    expect(textarea.isConnected).toBe(false)

    // Held down, the key repeats: each keydown lands on whatever has focus now.
    for (let repeat = 0; repeat < 5; repeat += 1) {
      fireEvent.keyDown(document.body, { key: 'Backspace', code: 'Backspace' })
      fireEvent.keyUp(document.body, { key: 'Backspace', code: 'Backspace' })
    }
    // React Flow removes nodes asynchronously (onBeforeDelete is awaited), so give it its turn.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50))
    })
    expect(chatNode()).not.toBeNull()
  })

  test('a Backspace press that begins after a pause is the ordinary delete key', async () => {
    const textarea = await mountSelectedChat()
    fireEvent.keyDown(textarea, { key: 'Backspace', code: 'Backspace' })
    await act(async () => {
      mock.emit(NODE_ID, decision)
    })
    await screen.findByText('Read-only first?')

    vi.advanceTimersByTime(5_000)
    fireEvent.keyDown(document.body, { key: 'Backspace', code: 'Backspace' })

    await waitFor(() => expect(chatNode()).toBeNull())
  })

  test('Delete on a selected chat nobody was typing in still closes it', async () => {
    await mountSelectedChat()
    ;(document.activeElement as HTMLElement | null)?.blur()
    fireEvent.keyDown(document.body, { key: 'Delete', code: 'Delete' })

    await waitFor(() => expect(chatNode()).toBeNull())
  })
})

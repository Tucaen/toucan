import { useLayoutEffect } from 'react'
import { renderHook } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { createSessionCanvasNode, type CanvasNode } from '../src/renderer/src/canvas-workspace'
import { useTicketSessionSpawns } from '../src/renderer/src/use-ticket-session-spawns'
import type { TicketSessionCanvasRequest } from '../src/shared/ticket-session-spawn'

test('an effect from before a spawn cannot mistake the new node for a closed one', () => {
  let receive: (id: string, request: TicketSessionCanvasRequest) => void = () => undefined
  const complete = vi.fn()
  const previous = Object.getOwnPropertyDescriptor(window, 'orchestratorApi')
  Object.defineProperty(window, 'orchestratorApi', {
    configurable: true,
    value: {
      onStartTicketSession: (callback: typeof receive) => {
        receive = callback
        return () => undefined
      },
      completeTicketSession: complete
    }
  })
  const request: TicketSessionCanvasRequest = {
    provider: 'codex',
    projectId: 'project',
    worktree: { path: 'D:/ticket', branch: 'ticket/44', baseRef: 'main' },
    label: '#44',
    modelId: 'gpt-6',
    effortId: 'high',
    orchestratedBy: { nodeId: 'captain', conversationId: 'captain-conversation', provider: 'codex' },
    prompt: 'Implement'
  }
  const start = vi.fn(() => ({ ok: true as const, nodeId: 'ticket' }))
  const ticket = createSessionCanvasNode(
    {
      id: 'ticket',
      kind: 'codex',
      label: '#44',
      position: { x: 0, y: 0 },
      conversationId: 'ticket-conversation',
      launchMode: 'new'
    },
    { id: 'project', name: 'Project', path: 'D:/project', color: '#71a9ff' },
    undefined,
    {
      onStatusChange: () => undefined,
      onConversationId: () => undefined,
      onTitleChange: async () => true,
      onFocusModeChange: () => undefined,
      onDraftChange: () => undefined,
      onPermissionModeChange: () => undefined,
      onModelChange: () => undefined,
      onResume: () => undefined
    }
  )
  try {
    const { rerender, unmount } = renderHook(
      ({ nodes, spawn }: { nodes: CanvasNode[]; spawn: boolean }) => {
        // Deliver between render and its passive effects, as a main-process request can arrive.
        useLayoutEffect(() => {
          if (spawn) receive('request', request)
        }, [spawn])
        useTicketSessionSpawns(start, nodes, { ticket: 'idle' })
      },
      { initialProps: { nodes: [] as CanvasNode[], spawn: false } }
    )
    rerender({ nodes: [], spawn: true })
    expect(start).toHaveBeenCalledTimes(1)
    expect(complete).not.toHaveBeenCalled()
    rerender({ nodes: [ticket], spawn: true })
    expect(complete).toHaveBeenCalledExactlyOnceWith('request', {
      ok: true,
      nodeId: 'ticket',
      conversationId: 'ticket-conversation'
    })
    unmount()
  } finally {
    if (previous) Object.defineProperty(window, 'orchestratorApi', previous)
    else Reflect.deleteProperty(window, 'orchestratorApi')
  }
})

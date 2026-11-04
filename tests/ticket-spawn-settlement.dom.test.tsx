import { useLayoutEffect } from 'react'
import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createSessionCanvasNode, type CanvasNode } from '../src/renderer/src/canvas-workspace'
import { useTicketSessionSpawns } from '../src/renderer/src/use-ticket-session-spawns'
import type { TerminalNodeStatus } from '../src/shared/terminal'
import type { TicketSessionCanvasRequest } from '../src/shared/ticket-session-spawn'

let receive: (id: string, request: TicketSessionCanvasRequest) => void = () => undefined
let cancel: (id: string) => void = () => undefined
const complete = vi.fn()
let previous: PropertyDescriptor | undefined

beforeEach(() => {
  complete.mockReset()
  previous = Object.getOwnPropertyDescriptor(window, 'orchestratorApi')
  Object.defineProperty(window, 'orchestratorApi', {
    configurable: true,
    value: {
      onStartTicketSession: (callback: typeof receive) => {
        receive = callback
        return () => undefined
      },
      onCancelTicketSession: (callback: typeof cancel) => {
        cancel = callback
        return () => undefined
      },
      completeTicketSession: complete
    }
  })
})

afterEach(() => {
  if (previous) Object.defineProperty(window, 'orchestratorApi', previous)
  else Reflect.deleteProperty(window, 'orchestratorApi')
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

interface Props {
  nodes: CanvasNode[]
  statuses: Record<string, TerminalNodeStatus>
  spawn: boolean
}

function renderSpawns(close: (nodeId: string) => void = () => undefined, initialProps?: Props) {
  const start = vi.fn(() => ({ ok: true as const, nodeId: 'ticket' }))
  const rendered = renderHook(
    ({ nodes, statuses, spawn }: Props) => {
      // Deliver between render and its passive effects, as a main-process request can arrive.
      useLayoutEffect(() => {
        if (spawn) receive('request', request)
      }, [spawn])
      useTicketSessionSpawns(start, close, nodes, statuses)
    },
    { initialProps: initialProps ?? { nodes: [], statuses: {}, spawn: false } }
  )
  return { ...rendered, start }
}

test('an effect from before a spawn cannot mistake the new node for a closed one', () => {
  const { rerender, unmount, start } = renderSpawns()
  rerender({ nodes: [], statuses: { ticket: 'idle' }, spawn: true })
  expect(start).toHaveBeenCalledTimes(1)
  expect(complete).not.toHaveBeenCalled()
  rerender({ nodes: [ticket], statuses: { ticket: 'idle' }, spawn: true })
  expect(complete).toHaveBeenCalledExactlyOnceWith('request', {
    ok: true,
    nodeId: 'ticket',
    conversationId: 'ticket-conversation'
  })
  unmount()
})

// Issue #1: main gave up after its timeout and told the orchestrator the spawn failed, but the
// session came up minutes later and took the ticket prompt. Withdrawn, it must be closed instead.
test('a session main stopped waiting for is closed, and its late start is never reported', () => {
  const close = vi.fn()
  const { rerender, unmount } = renderSpawns(close)
  rerender({ nodes: [], statuses: {}, spawn: true })
  rerender({ nodes: [ticket], statuses: { ticket: 'starting' }, spawn: true })
  expect(complete).not.toHaveBeenCalled()

  cancel('request')
  expect(close).toHaveBeenCalledExactlyOnceWith('ticket')

  rerender({ nodes: [ticket], statuses: { ticket: 'ready' }, spawn: true })
  expect(complete).not.toHaveBeenCalled()
  unmount()
})

test('a withdrawal that crosses the verdict in flight still closes the session', () => {
  const close = vi.fn()
  const { rerender, unmount } = renderSpawns(close)
  rerender({ nodes: [], statuses: {}, spawn: true })
  rerender({ nodes: [ticket], statuses: { ticket: 'ready' }, spawn: true })
  expect(complete).toHaveBeenCalledOnce()

  // Main's timeout fired before that verdict reached it, so the spawn was answered as failed.
  cancel('request')
  expect(close).toHaveBeenCalledExactlyOnceWith('ticket')
  unmount()
})

test('a withdrawal of a request this window never started closes nothing', () => {
  const close = vi.fn()
  const { unmount } = renderSpawns(close)
  cancel('unknown')
  expect(close).not.toHaveBeenCalled()
  unmount()
})

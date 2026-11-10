import { useLayoutEffect } from 'react'
import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createSessionCanvasNode, isTerminalCanvasNode, type CanvasNode } from '../src/renderer/src/canvas-workspace'
import { useTicketSessionSpawns } from '../src/renderer/src/use-ticket-session-spawns'
import type { TerminalNodeStatus } from '../src/shared/terminal'
import type { TicketSessionCanvasRequest } from '../src/shared/ticket-session-spawn'

let receive: (id: string, request: TicketSessionCanvasRequest) => void = () => undefined
let cancel: (id: string) => void = () => undefined
const complete = vi.fn()
const progress = vi.fn()
let previous: PropertyDescriptor | undefined

beforeEach(() => {
  complete.mockReset()
  progress.mockReset()
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
      completeTicketSession: complete,
      progressTicketSession: progress
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
    onModelChange: () => undefined,
    onResume: () => undefined
  }
)

interface Props {
  nodes: CanvasNode[]
  statuses: Record<string, TerminalNodeStatus>
  spawn: boolean
}

function renderSpawns(
  close: (nodeId: string) => void = () => undefined,
  dropPrompt: (nodeId: string) => void = () => undefined
) {
  const start = vi.fn(() => ({ ok: true as const, nodeId: 'ticket' }))
  const rendered = renderHook(
    ({ nodes, statuses, spawn }: Props) => {
      // Deliver between render and its passive effects, as a main-process request can arrive.
      useLayoutEffect(() => {
        if (spawn) receive('request', request)
      }, [spawn])
      useTicketSessionSpawns({ start, close, dropPrompt }, nodes, statuses)
    },
    { initialProps: { nodes: [] as CanvasNode[], statuses: {}, spawn: false } }
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

// Issue #1: the orchestrator's spawn links the session as soon as its node exists and keeps it
// linked when the wait runs out, so the renderer reports the node at once and its verdict whenever
// it comes - however long after main stopped waiting.
test('the node is reported the moment it exists, and its conversation id when it has one', () => {
  const { rerender, unmount } = renderSpawns()
  rerender({ nodes: [], statuses: {}, spawn: true })
  expect(progress).toHaveBeenCalledExactlyOnceWith('request', { nodeId: 'ticket' })

  // Still starting: nothing is answered, but the conversation id main is waiting to link is passed on once.
  rerender({ nodes: [ticket], statuses: { ticket: 'starting' }, spawn: true })
  rerender({ nodes: [ticket], statuses: { ticket: 'starting' }, spawn: true })
  expect(complete).not.toHaveBeenCalled()
  expect(progress).toHaveBeenCalledTimes(2)
  expect(progress).toHaveBeenLastCalledWith('request', { nodeId: 'ticket', conversationId: 'ticket-conversation' })
  unmount()
})

test('a session that comes up long after it was reported is still answered', () => {
  const close = vi.fn()
  const { rerender, unmount } = renderSpawns(close)
  rerender({ nodes: [], statuses: {}, spawn: true })
  for (let beat = 0; beat < 5; beat += 1) rerender({ nodes: [ticket], statuses: { ticket: 'starting' }, spawn: true })
  expect(complete).not.toHaveBeenCalled()

  rerender({ nodes: [ticket], statuses: { ticket: 'ready' }, spawn: true })
  expect(complete).toHaveBeenCalledExactlyOnceWith('request', {
    ok: true,
    nodeId: 'ticket',
    conversationId: 'ticket-conversation'
  })
  expect(close).not.toHaveBeenCalled()
  unmount()
})

test('a node main cancels is closed and its late start is never reported', () => {
  const close = vi.fn()
  const { rerender, unmount } = renderSpawns(close)
  rerender({ nodes: [], statuses: {}, spawn: true })
  rerender({ nodes: [ticket], statuses: { ticket: 'starting' }, spawn: true })
  expect(complete).not.toHaveBeenCalled()

  cancel('ticket')
  expect(close).toHaveBeenCalledExactlyOnceWith('ticket')

  rerender({ nodes: [ticket], statuses: { ticket: 'ready' }, spawn: true })
  expect(complete).not.toHaveBeenCalled()
  unmount()
})

test('a failure verdict drops the prompt of a node still on the canvas, so a later start cannot take it', () => {
  const dropPrompt = vi.fn()
  const close = vi.fn()
  const { rerender, unmount } = renderSpawns(close, dropPrompt)
  rerender({ nodes: [], statuses: {}, spawn: true })
  rerender({ nodes: [ticket], statuses: { ticket: 'exited' }, spawn: true })
  expect(complete).toHaveBeenCalledExactlyOnceWith('request', {
    ok: false,
    message: 'The ticket session could not be started on the desktop.'
  })
  expect(dropPrompt).toHaveBeenCalledExactlyOnceWith('ticket')
  // Its session is already down and its error stays in view.
  expect(close).not.toHaveBeenCalled()
  unmount()
})

test('a session that is up but has no conversation to track is closed, not left working the ticket', () => {
  const close = vi.fn()
  const { rerender, unmount } = renderSpawns(close)
  const untracked: CanvasNode = isTerminalCanvasNode(ticket)
    ? { ...ticket, data: { ...ticket.data, conversationId: undefined } }
    : ticket
  rerender({ nodes: [], statuses: {}, spawn: true })
  rerender({ nodes: [untracked], statuses: { ticket: 'idle' }, spawn: true })
  expect(complete).toHaveBeenCalledExactlyOnceWith('request', {
    ok: false,
    message: 'The ticket session could not be started on the desktop.'
  })
  expect(close).toHaveBeenCalledExactlyOnceWith('ticket')
  unmount()
})

import { act, renderHook } from '@testing-library/react'
import { expect, it } from 'vitest'
import { useState } from 'react'
import type { CanvasNode } from '../src/renderer/src/canvas-workspace'
import { useWorkspaceAttention } from '../src/renderer/src/workspace-attention'

const terminalNode = {
  id: 'node-1',
  type: 'terminalNode',
  position: { x: 0, y: 0 },
  data: { kind: 'codex', sessionId: 'session-1', label: 'Codex', projectId: 'project-1' }
} as CanvasNode

it('coordinates durable attention records, counts, and their projection onto canvas nodes', () => {
  const { result } = renderHook(() => {
    const [nodes, setNodes] = useState<CanvasNode[]>([terminalNode])
    const attention = useWorkspaceAttention(nodes, setNodes)
    return { nodes, attention }
  })

  act(() => {
    result.current.attention.report({
      type: 'raise',
      signal: { nodeId: 'node-1', kind: 'result', key: 'turn-1' }
    })
  })

  expect(result.current.attention.unreadTotal).toBe(1)
  expect(result.current.attention.unreadByNode).toEqual({ 'node-1': 1 })
  expect(result.current.attention.count(['node-1'])).toBe(1)
  expect(result.current.attention.count(['another-node'])).toBe(0)
  expect(result.current.nodes[0].data.unread).toBe(1)
  expect(result.current.nodes[0].data.unreadKind).toBe('result')

  act(() => result.current.attention.forget(new Set(['node-1'])))

  expect(result.current.attention.unreadTotal).toBe(0)
})

it('keeps hidden kinds in the persisted records while counting only what the user must act on', () => {
  const orchestrator = {
    id: 'orch',
    type: 'terminalNode',
    position: { x: 0, y: 0 },
    data: { kind: 'claude', sessionId: 's-orch', label: 'Orch', projectId: 'project-1', role: 'orchestrator' }
  } as CanvasNode
  const ticketWorktree = {
    id: 'wt-node',
    type: 'worktreeNode',
    position: { x: 0, y: 0 },
    data: { worktreeId: 'wt-1', projectId: 'project-1', branch: 'ticket/1' }
  } as unknown as CanvasNode
  const ticketChat = {
    id: 'ticket-chat',
    type: 'terminalNode',
    position: { x: 0, y: 0 },
    data: {
      kind: 'claude',
      sessionId: 's-ticket',
      label: 'Ticket',
      projectId: 'project-1',
      worktreeId: 'wt-1',
      orchestratedBy: { nodeId: 'orch', conversationId: 'conv-orch', provider: 'claude' }
    }
  } as CanvasNode

  const { result } = renderHook(() => {
    const [nodes, setNodes] = useState<CanvasNode[]>([orchestrator, ticketWorktree, ticketChat])
    return useWorkspaceAttention(nodes, setNodes)
  })

  act(() => {
    for (const kind of ['approval', 'result', 'failure', 'output'] as const) {
      result.current.report({ type: 'raise', signal: { nodeId: 'ticket-chat', kind } })
    }
  })

  expect(result.current.records.map((item) => item.kind).sort()).toEqual(['approval', 'failure', 'output', 'result'])
  expect(result.current.visibleRecords.map((item) => item.kind)).toEqual(['approval'])
  expect(result.current.unreadTotal).toBe(1)
})

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
    const attention = useWorkspaceAttention(setNodes)
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

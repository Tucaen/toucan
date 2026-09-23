import { strict as assert } from 'node:assert'
import { test } from 'vitest'
import type { CanvasNode } from '../src/renderer/src/canvas-workspace'
import { planHistoryOpen } from '../src/renderer/src/history-open'

/** Only what the plan reads; the rest of a canvas node is irrelevant to it. */
function node(id: string, data: { kind: string; conversationId?: string }, type = 'terminalNode'): CanvasNode {
  return { id, type, position: { x: 0, y: 0 }, data } as unknown as CanvasNode
}

test('an entry already open on the canvas focuses that node instead of opening a second session', () => {
  const nodes = [
    node('other', { kind: 'codex', conversationId: 'thread-2' }),
    node('holder', { kind: 'codex', conversationId: 'thread-1' })
  ]
  assert.deepEqual(planHistoryOpen(nodes, { provider: 'codex', id: 'thread-1' }), {
    action: 'focus',
    nodeId: 'holder'
  })
})

test('the same conversation id on another provider is a different conversation', () => {
  const nodes = [node('claude-node', { kind: 'claude', conversationId: 'shared-id' })]
  assert.deepEqual(planHistoryOpen(nodes, { provider: 'codex', id: 'shared-id' }), { action: 'open' })
})

test('an entry nobody holds opens a new node', () => {
  assert.deepEqual(planHistoryOpen([node('empty', { kind: 'codex' })], { provider: 'codex', id: 'thread-1' }), {
    action: 'open'
  })
})

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import type { CanvasNode } from '../src/renderer/src/canvas-workspace'
import { createBackspaceChatShield } from '../src/renderer/src/chat-backspace-shield'

// The pure half of #2; tests/chat-backspace-never.dom.test.tsx drives it through the real App.

const chat = { id: 'chat', type: 'terminalNode', data: { kind: 'claude' } } as unknown as CanvasNode
const terminal = { id: 'term', type: 'terminalNode', data: { kind: 'terminal' } } as unknown as CanvasNode
const file = { id: 'file', type: 'fileNode', data: {} } as unknown as CanvasNode

const lineage = { id: 'e-chat', source: 'term', target: 'chat' }
const unrelated = { id: 'e-other', source: 'term', target: 'file' }

function press(shield: ReturnType<typeof createBackspaceChatShield>, key: string, type = 'keydown'): void {
  shield.track({ type, key, code: key })
}

describe('chat backspace shield', () => {
  test('Backspace holds a chat back and lets every other kind go', async () => {
    const shield = createBackspaceChatShield()
    press(shield, 'Backspace')
    const result = await shield.beforeDelete({ nodes: [chat, terminal, file], edges: [] })
    assert.deepEqual(
      result.nodes.map((node) => node.id),
      ['term', 'file']
    )
  })

  test('Delete removes a chat as before', async () => {
    const shield = createBackspaceChatShield()
    press(shield, 'Delete')
    const input = { nodes: [chat, file], edges: [lineage] }
    assert.deepEqual(await shield.beforeDelete(input), input)
  })

  test('with no key tracked at all the chat is removable (nothing asked via Backspace)', async () => {
    const shield = createBackspaceChatShield()
    assert.equal((await shield.beforeDelete({ nodes: [chat], edges: [] })).nodes.length, 1)
  })

  test('an edge stays with the chat that stays, unless it was selected itself', async () => {
    const shield = createBackspaceChatShield()
    press(shield, 'Backspace')
    const kept = await shield.beforeDelete({ nodes: [chat, file], edges: [lineage, unrelated] })
    assert.deepEqual(
      kept.edges.map((edge) => edge.id),
      ['e-other']
    )
    const own = await shield.beforeDelete({ nodes: [chat], edges: [{ ...lineage, selected: true }] })
    assert.deepEqual(
      own.edges.map((edge) => edge.id),
      ['e-chat']
    )
  })

  test('a Backspace that was released, or lost with the window, no longer protects', async () => {
    const shield = createBackspaceChatShield()
    press(shield, 'Backspace')
    press(shield, 'Backspace', 'keyup')
    assert.equal((await shield.beforeDelete({ nodes: [chat], edges: [] })).nodes.length, 1)

    press(shield, 'Backspace')
    shield.reset()
    assert.equal((await shield.beforeDelete({ nodes: [chat], edges: [] })).nodes.length, 1)
  })

  test('a later key replaces Backspace as the one held', async () => {
    const shield = createBackspaceChatShield()
    press(shield, 'Backspace')
    press(shield, 'Delete')
    assert.equal((await shield.beforeDelete({ nodes: [chat], edges: [] })).nodes.length, 1)
  })
})

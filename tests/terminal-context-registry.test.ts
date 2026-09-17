import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  createTerminalContextRegistry,
  registerTerminalContextIpc,
  type TerminalContextRegistry
} from '../src/main/terminal-context-registry'
import { TERMINAL_CONTEXT_CHANNELS } from '../src/shared/ipc-channels'
import { parseTerminalContextEdges } from '../src/shared/terminal-context'

test('an edge grants the read and its absence refuses it', () => {
  const registry = createTerminalContextRegistry()
  // Nothing published yet: every check refuses. The tool definition never implies the capability.
  assert.equal(registry.hasEdge('chat-node', 'shell-1'), false)

  registry.replaceEdges([{ terminalSessionId: 'shell-1', agentId: 'chat-node' }])
  assert.equal(registry.hasEdge('chat-node', 'shell-1'), true)
  // The grant is per pair, not per agent or per terminal.
  assert.equal(registry.hasEdge('chat-node', 'shell-2'), false)
  assert.equal(registry.hasEdge('other-chat', 'shell-1'), false)
})

test('a full-set replace revokes whatever the new set no longer carries', () => {
  const registry = createTerminalContextRegistry()
  registry.replaceEdges([
    { terminalSessionId: 'shell-1', agentId: 'chat-node' },
    { terminalSessionId: 'shell-2', agentId: 'chat-node' }
  ])
  // The node owning shell-1 closed; the renderer publishes the set without it.
  registry.replaceEdges([{ terminalSessionId: 'shell-2', agentId: 'chat-node' }])
  assert.equal(registry.hasEdge('chat-node', 'shell-1'), false)
  assert.equal(registry.hasEdge('chat-node', 'shell-2'), true)
})

test('a reloaded renderer resyncs by publishing its whole (empty) set', () => {
  const registry = createTerminalContextRegistry()
  registry.replaceEdges([{ terminalSessionId: 'shell-1', agentId: 'chat-node' }])
  // Edges are runtime-only, so a fresh renderer's first publish is empty - and that is the truth.
  registry.replaceEdges([])
  assert.equal(registry.hasEdge('chat-node', 'shell-1'), false)
  assert.deepEqual(registry.terminalSessionIdsFor('chat-node'), [])
})

test('terminalSessionIdsFor lists exactly the agent’s connected terminals in publish order', () => {
  const registry = createTerminalContextRegistry()
  registry.replaceEdges([
    { terminalSessionId: 'shell-1', agentId: 'chat-node' },
    { terminalSessionId: 'shell-3', agentId: 'other-chat' },
    { terminalSessionId: 'shell-2', agentId: 'chat-node' }
  ])
  assert.deepEqual(registry.terminalSessionIdsFor('chat-node'), ['shell-1', 'shell-2'])
  assert.deepEqual(registry.terminalSessionIdsFor('other-chat'), ['shell-3'])
  assert.deepEqual(registry.terminalSessionIdsFor('unknown'), [])
})

test('the registry re-validates across the seam: malformed entries drop, duplicates collapse', () => {
  assert.deepEqual(parseTerminalContextEdges('not-an-array'), [])
  assert.deepEqual(
    parseTerminalContextEdges([
      { terminalSessionId: 'shell-1', agentId: 'chat-node' },
      { terminalSessionId: 'shell-1', agentId: 'chat-node' },
      { terminalSessionId: '', agentId: 'chat-node' },
      { terminalSessionId: 'shell-2', agentId: 42 },
      null,
      'text'
    ]),
    [{ terminalSessionId: 'shell-1', agentId: 'chat-node' }]
  )

  const registry = createTerminalContextRegistry()
  registry.replaceEdges([
    { terminalSessionId: 'shell-1', agentId: 'chat-node' },
    { terminalSessionId: '', agentId: 'chat-node' } as never
  ])
  assert.equal(registry.hasEdge('chat-node', 'shell-1'), true)
  assert.equal(registry.hasEdge('chat-node', ''), false)
})

test('the IPC channel replaces the set on every publish', () => {
  const listeners = new Map<string, (event: { sender: unknown }, ...args: unknown[]) => void>()
  const registrar = {
    handle: () => undefined,
    on: (channel: string, listener: (event: { sender: unknown }, ...args: unknown[]) => void) => {
      listeners.set(channel, listener)
    }
  }
  const registry: TerminalContextRegistry = createTerminalContextRegistry()
  registerTerminalContextIpc(registrar, registry)

  const publish = listeners.get(TERMINAL_CONTEXT_CHANNELS.replaceEdges)
  assert.ok(publish)
  publish({ sender: null }, [{ terminalSessionId: 'shell-1', agentId: 'chat-node' }])
  assert.equal(registry.hasEdge('chat-node', 'shell-1'), true)
  publish({ sender: null }, [])
  assert.equal(registry.hasEdge('chat-node', 'shell-1'), false)
  // Garbage over the wire empties nothing it should not and grants nothing at all.
  publish({ sender: null }, { terminalSessionId: 'shell-1', agentId: 'chat-node' })
  assert.equal(registry.hasEdge('chat-node', 'shell-1'), false)
})

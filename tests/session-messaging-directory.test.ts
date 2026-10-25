import { strict as assert } from 'node:assert'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'
import { chatNodeIds, createMessagingDirectory } from '../src/main/session-messaging-directory'
import { createSessionMessagingSettingsReader } from '../src/main/session-messaging-store'
import type { WorkspaceState, WorkspaceTerminalNode } from '../src/shared/workspace'

// #2: who messaging sees on the canvas - chats, ticket sessions and orchestrators of a project,
// never a terminal - and how its limits are configured.

function node(id: string, extra: Partial<WorkspaceTerminalNode> = {}): WorkspaceTerminalNode {
  return {
    id,
    kind: 'claude',
    label: `${id} title`,
    projectId: 'p1',
    position: { x: 0, y: 0 },
    width: 100,
    height: 100,
    ...extra
  }
}

const state = {
  projects: [
    { id: 'p1', name: 'one', path: 'D:\\one', color: '#112233' },
    { id: 'p2', name: 'two', path: 'D:\\two', color: '#112233' }
  ],
  worktrees: [{ id: 'w1', projectId: 'p1', branch: 'ticket/7', path: 'D:\\wt\\ticket-7' }],
  nodes: [
    node('chat'),
    node('ticket', {
      kind: 'codex',
      worktreeId: 'w1',
      orchestratedBy: { nodeId: 'orchestrator', conversationId: 'c-o', provider: 'claude' }
    }),
    node('orchestrator', { role: 'orchestrator' }),
    node('shell', { kind: 'terminal' }),
    node('elsewhere', { projectId: 'p2' })
  ]
} as unknown as WorkspaceState

test('a project lists its chats with role, ticket id, branch and last activity; terminals are not sessions', async () => {
  const branchReads: string[] = []
  const directory = createMessagingDirectory({
    workspace: async () => state,
    ticketIdFor: async (candidate) => (candidate.id === 'ticket' ? '7' : undefined),
    branchOf: async (path) => {
      branchReads.push(path)
      return 'main'
    },
    updatedAtFor: async (candidate) => (candidate.id === 'chat' ? '2026-10-25T10:00:00.000Z' : undefined)
  })
  assert.deepEqual(await directory.project('p1'), [
    {
      nodeId: 'chat',
      projectId: 'p1',
      provider: 'claude',
      role: 'chat',
      title: 'chat title',
      branch: 'main',
      updatedAt: '2026-10-25T10:00:00.000Z'
    },
    {
      nodeId: 'ticket',
      projectId: 'p1',
      provider: 'codex',
      role: 'ticket',
      title: 'ticket title',
      ticketId: '7',
      branch: 'ticket/7'
    },
    {
      nodeId: 'orchestrator',
      projectId: 'p1',
      provider: 'claude',
      role: 'orchestrator',
      title: 'orchestrator title',
      branch: 'main'
    }
  ])
  // The checkout's branch is asked once per listing, not once per chat.
  assert.deepEqual(branchReads, ['D:\\one'])
  assert.equal(await directory.entry('shell'), undefined)
  assert.equal(await directory.entry('missing'), undefined)
  assert.equal((await directory.entry('elsewhere'))?.projectId, 'p2')
  assert.deepEqual([...chatNodeIds(state)].sort(), ['chat', 'elsewhere', 'orchestrator', 'ticket'])
})

test('the limits come from the settings file, and a missing or broken one keeps the defaults', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'toucan-messaging-settings-'))
  const path = join(directory, 'session-messaging.json')
  const logged: string[] = []
  const read = createSessionMessagingSettingsReader({ path, log: (message) => logged.push(message) })
  assert.deepEqual(await read(), { hopLimit: 3, asksPerTurn: 5 })
  assert.deepEqual(logged, [])
  writeFileSync(path, JSON.stringify({ hopLimit: 2, asksPerTurn: 8 }))
  assert.deepEqual(await read(), { hopLimit: 2, asksPerTurn: 8 })
  writeFileSync(path, JSON.stringify({ hopLimit: 0 }))
  assert.deepEqual(await read(), { hopLimit: 3, asksPerTurn: 5 })
  writeFileSync(path, '{ not json')
  assert.deepEqual(await read(), { hopLimit: 3, asksPerTurn: 5 })
  assert.equal(logged.length, 2)
})

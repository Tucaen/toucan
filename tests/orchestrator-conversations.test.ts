import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'
import { createOrchestratorConversations, withOrchestratorRoles } from '../src/main/orchestrator-conversations'
import type { OrchestrationKey } from '../src/main/orchestration-store'
import type { WorkspaceLoadResult, WorkspaceTerminalNode } from '../src/shared/workspace'

// Tucaen/toucan#1: whether a conversation is an orchestrator's is kept with the conversation, so a
// node that comes back without its role - from History, or saved that way - can be given it back.

function withDirectory(run: (directory: string) => Promise<void>): () => Promise<void> {
  return async () => {
    const directory = mkdtempSync(join(tmpdir(), 'toucan-orchestrator-conversations-'))
    try {
      await run(directory)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }
}

function recordsHolding(...keys: OrchestrationKey[]) {
  return {
    has: async (key: OrchestrationKey) =>
      keys.some((held) => held.provider === key.provider && held.conversationId === key.conversationId)
  }
}

test(
  'a conversation marked when its orchestrator session opened is known after reopening the store, per provider',
  withDirectory(async (directory) => {
    const path = join(directory, 'orchestrator-conversations.json')
    const conversations = createOrchestratorConversations({ path, records: recordsHolding() })
    assert.equal(await conversations.has({ provider: 'claude', conversationId: 'c1' }), false)
    await conversations.remember({ provider: 'claude', conversationId: 'c1' })

    const reopened = createOrchestratorConversations({ path, records: recordsHolding() })
    assert.equal(await reopened.has({ provider: 'claude', conversationId: 'c1' }), true)
    assert.equal(await reopened.has({ provider: 'codex', conversationId: 'c1' }), false)
  })
)

test(
  'a conversation with an orchestration record is an orchestrator even without a marker',
  withDirectory(async (directory) => {
    const conversations = createOrchestratorConversations({
      path: join(directory, 'orchestrator-conversations.json'),
      records: recordsHolding({ provider: 'codex', conversationId: 'planned' })
    })
    assert.equal(await conversations.has({ provider: 'codex', conversationId: 'planned' }), true)
    assert.equal(await conversations.has({ provider: 'claude', conversationId: 'planned' }), false)
  })
)

test(
  'a damaged marker file or an unreadable record answers "not known" rather than throwing',
  withDirectory(async (directory) => {
    const path = join(directory, 'orchestrator-conversations.json')
    writeFileSync(path, '{ not json')
    const conversations = createOrchestratorConversations({
      path,
      records: {
        has: async () => {
          throw new Error('EBUSY')
        }
      }
    })
    assert.equal(await conversations.has({ provider: 'claude', conversationId: 'c1' }), false)
  })
)

const node = (overrides: Partial<WorkspaceTerminalNode>): WorkspaceTerminalNode => ({
  id: 'node',
  kind: 'claude',
  label: 'Chat',
  projectId: 'project',
  position: { x: 0, y: 0 },
  width: 750,
  height: 660,
  ...overrides
})

function loaded(nodes: WorkspaceTerminalNode[], recentlyClosedNodes?: WorkspaceTerminalNode[]): WorkspaceLoadResult {
  return {
    state: {
      version: 3,
      projects: [{ id: 'project', name: 'Project', path: 'D:\\Project', color: '#71a9ff' }],
      activeProjectId: 'project',
      sidebarCollapsed: false,
      nodes,
      worktrees: [],
      ...(recentlyClosedNodes ? { recentlyClosedNodes } : {})
    },
    recovered: false,
    unrecoverable: false
  }
}

test('a saved chat holding an orchestrator conversation gets its role back, on the canvas and in the reopen stack', async () => {
  const known = recordsHolding(
    { provider: 'claude', conversationId: 'orchestrator' },
    { provider: 'codex', conversationId: 'closed-orchestrator' }
  )
  const repaired = await withOrchestratorRoles(
    loaded(
      [
        node({ id: 'lost', conversationId: 'orchestrator' }),
        node({ id: 'plain', conversationId: 'plain-chat' }),
        node({ id: 'fresh' }),
        node({
          id: 'ticket',
          conversationId: 'orchestrator',
          orchestratedBy: { nodeId: 'gone', conversationId: 'orchestrator', provider: 'claude' }
        }),
        node({ id: 'shell', kind: 'terminal', conversationId: 'orchestrator' })
      ],
      [node({ id: 'closed', kind: 'codex', conversationId: 'closed-orchestrator' })]
    ),
    known
  )

  const roles = Object.fromEntries((repaired.state?.nodes ?? []).map((saved) => [saved.id, saved.role]))
  assert.deepEqual(roles, {
    lost: 'orchestrator',
    plain: undefined,
    fresh: undefined,
    ticket: undefined,
    shell: undefined
  })
  assert.equal(repaired.state?.recentlyClosedNodes?.[0].role, 'orchestrator')
})

test('a snapshot with nothing to repair is handed back untouched', async () => {
  const original = loaded([node({ id: 'orchestrator', conversationId: 'c', role: 'orchestrator' })])
  assert.equal(await withOrchestratorRoles(original, { has: async () => true }), original)
  const empty: WorkspaceLoadResult = { state: null, recovered: false, unrecoverable: true }
  assert.equal(await withOrchestratorRoles(empty, { has: async () => true }), empty)
})

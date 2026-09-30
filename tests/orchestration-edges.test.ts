import { strict as assert } from 'node:assert'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'
import { createWorkspaceStore } from '../src/main/workspace-store'
import {
  isTerminalCanvasNode,
  restoreCanvasWorkspace,
  serializeCanvasNode,
  type CanvasNode
} from '../src/renderer/src/canvas-workspace'
import { lineageEdges } from '../src/renderer/src/conversation-lineage'
import {
  ORCHESTRATED_EDGE_CLASS,
  orchestratedEdgeId,
  orchestratedEdges,
  orchestratedKey
} from '../src/renderer/src/orchestration-edges'
import { isValidTerminalContextConnection } from '../src/renderer/src/terminal-context-edges'
import type { WorkspaceState, WorkspaceTerminalNode } from '../src/shared/workspace'

// The orchestrated-by edge (#34): a projection of `orchestratedBy` on a ticket session, like the
// lineage edge - not drawable, not removable, granting nothing, and back after a restart.

const callbacks = {
  onStatusChange: () => undefined,
  onConversationId: () => undefined,
  onTitleChange: async () => true,
  onFocusModeChange: () => undefined,
  onDraftChange: () => undefined,
  onPermissionModeChange: () => undefined,
  onModelChange: () => undefined,
  onResume: () => undefined,
  onRemoveWorktree: () => undefined,
  onCreateNodeInWorktree: () => undefined,
  onRunSetupCommand: () => undefined,
  onOpenDiff: () => undefined,
  onViewModeChange: () => undefined,
  onRequestFilePath: async () => null,
  onPathChange: () => undefined,
  onSelectDiffPath: () => undefined
}

const link = { nodeId: 'orchestrator', conversationId: 'conversation-orchestrator' }

function workspace(nodes: WorkspaceTerminalNode[]): WorkspaceState {
  return {
    version: 3,
    projects: [{ id: 'project-1', name: 'Toucan', path: 'D:\\Development\\Toucan', color: '#71a9ff' }],
    activeProjectId: 'project-1',
    sidebarCollapsed: false,
    nodes,
    worktrees: [
      {
        id: 'worktree-34',
        projectId: 'project-1',
        path: 'D:\\Development\\Toucan-ticket-34',
        branch: 'ticket/34',
        baseRef: 'main',
        createdAt: '2026-09-30T12:00:00.000Z',
        position: { x: 900, y: 0 },
        width: 800,
        height: 700
      }
    ]
  }
}

function chat(id: string, overrides: Partial<WorkspaceTerminalNode> = {}): WorkspaceTerminalNode {
  return {
    id,
    kind: 'claude',
    label: id,
    projectId: 'project-1',
    position: { x: 0, y: 0 },
    width: 750,
    height: 660,
    conversationId: `conversation-${id}`,
    ...overrides
  }
}

function saved(): WorkspaceTerminalNode[] {
  return [
    chat('orchestrator', { role: 'orchestrator' }),
    chat('ticket', {
      label: '#34 Spawn',
      titleSource: 'manual',
      worktreeId: 'worktree-34',
      placement: 'worktree',
      orchestratedBy: link
    }),
    chat('bystander')
  ]
}

const restore = (nodes: WorkspaceTerminalNode[]): CanvasNode[] =>
  restoreCanvasWorkspace(workspace(nodes), callbacks).nodes

test('the orchestrated-by edge runs from the orchestrator to its ticket session and cannot be touched', () => {
  const edges = orchestratedEdges(restore(saved()))
  assert.deepEqual(
    edges.map((edge) => [edge.id, edge.source, edge.target]),
    [[orchestratedEdgeId('orchestrator', 'ticket'), 'orchestrator', 'ticket']]
  )
  const [edge] = edges
  assert.equal(edge.className, ORCHESTRATED_EDGE_CLASS)
  assert.equal(edge.selectable, false)
  assert.equal(edge.deletable, false)
  assert.equal(edge.reconnectable, false)
  // It is its own relationship, never a lineage edge.
  assert.deepEqual(lineageEdges(restore(saved())), [])
})

test('the orchestrated-by edge grants nothing: it is not a terminal-context connection', () => {
  const nodes = restore(saved())
  assert.equal(isValidTerminalContextConnection(nodes, { source: 'orchestrator', target: 'ticket' }), false)
  assert.equal(isValidTerminalContextConnection(nodes, { source: 'ticket', target: 'orchestrator' }), false)
})

test('the orchestrated-by edge survives a restart through the workspace store', async () => {
  const nodes = restore(saved())
  const serialized = nodes.filter(isTerminalCanvasNode).map(serializeCanvasNode)
  assert.deepEqual(serialized.find((entry) => entry.id === 'ticket')?.orchestratedBy, link)
  assert.equal(serialized.find((entry) => entry.id === 'bystander')?.orchestratedBy, undefined)

  const store = createWorkspaceStore(join(mkdtempSync(join(tmpdir(), 'toucan-orchestrated-edge-')), 'workspace.json'))
  const written = await store.save(workspace(serialized))
  assert.equal(written.ok, true)
  const loaded = (await store.load()).state
  assert.ok(loaded, 'the saved workspace loads')
  const restarted = restoreCanvasWorkspace(loaded, callbacks).nodes
  assert.deepEqual(
    orchestratedEdges(restarted).map((edge) => edge.id),
    [orchestratedEdgeId('orchestrator', 'ticket')]
  )
})

test('a closed orchestrator draws nothing while the ticket session keeps its link', () => {
  const nodes = restore(saved()).filter((node) => node.id !== 'orchestrator')
  assert.deepEqual(orchestratedEdges(nodes), [])
  const ticket = nodes.find((node) => node.id === 'ticket')
  assert.deepEqual(ticket && isTerminalCanvasNode(ticket) ? ticket.data.orchestratedBy : undefined, link)
})

test('the store refuses a malformed link and a link on a terminal', async () => {
  const store = createWorkspaceStore(join(mkdtempSync(join(tmpdir(), 'toucan-orchestrated-edge-')), 'workspace.json'))
  for (const node of [
    chat('ticket', { orchestratedBy: { nodeId: 'orchestrator' } as never }),
    chat('shell', { kind: 'terminal', orchestratedBy: link })
  ]) {
    await store.save(workspace([node]))
    const loaded = (await store.load()).state
    // Refused rather than repaired, like a malformed `branchedFrom`: no link reaches the canvas.
    assert.ok(!loaded?.nodes.some((entry) => entry.orchestratedBy), node.id)
  }
})

test('the projection key moves with the link, not with a drag', () => {
  const nodes = restore(saved())
  const dragged = nodes.map((node) => ({ ...node, position: { x: node.position.x + 10, y: node.position.y } }))
  assert.equal(orchestratedKey(dragged), orchestratedKey(nodes))
  assert.notEqual(orchestratedKey(nodes.filter((node) => node.id !== 'ticket')), orchestratedKey(nodes))
})

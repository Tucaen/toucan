import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { restoreCanvasWorkspace, serializeCanvasNode } from '../src/renderer/src/canvas-workspace'
import type { WorkspaceState } from '../src/shared/terminal'

test('restores saved canvas nodes and ignores nodes whose project is gone', () => {
  const state: WorkspaceState = {
    version: 2,
    projects: [{ id: 'project-1', name: 'ADE', path: 'D:\\Development\\ADE', color: '#71a9ff' }],
    activeProjectId: 'missing-project',
    sidebarCollapsed: false,
    nodes: [
      {
        id: 'node-1',
        kind: 'codex',
        label: 'Codex 7',
        projectId: 'project-1',
        position: { x: 30, y: 50 },
        width: 540,
        height: 360,
        conversationId: 'conversation-7'
      },
      {
        id: 'orphan',
        kind: 'terminal',
        label: 'Terminal 8',
        projectId: 'deleted-project',
        position: { x: 0, y: 0 },
        width: 520,
        height: 340
      }
    ]
  }
  const restored = restoreCanvasWorkspace(state, {
    onStatusChange: () => undefined,
    onConversationId: () => undefined,
    onPreview: () => undefined,
    onResume: () => undefined
  })

  assert.equal(restored.nodes.length, 1)
  assert.equal(restored.nodes[0].data.dormant, true)
  assert.equal(restored.nodes[0].data.projectPath, 'D:\\Development\\ADE')
  assert.equal(restored.nextSessionNumber, 8)
  assert.equal(restored.activeProjectId, 'project-1')
  assert.deepEqual(serializeCanvasNode(restored.nodes[0]), state.nodes[0])
})

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
    agentPermissionModes: { codex: 'read-only' },
    nodes: [
      {
        id: 'node-1',
        kind: 'codex',
        label: 'Codex 7',
        projectId: 'project-1',
        position: { x: 30, y: 50 },
        width: 540,
        height: 360,
        conversationId: 'conversation-7',
        modelId: 'gpt-5-codex',
        worklogCollapsed: true
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
    onWorklogCollapsed: () => undefined,
    onPermissionModeChange: () => undefined,
    onModelChange: () => undefined,
    onResume: () => undefined
  })

  assert.equal(restored.nodes.length, 1)
  assert.equal(restored.nodes[0].data.dormant, true)
  assert.equal(restored.nodes[0].data.projectPath, 'D:\\Development\\ADE')
  assert.equal(restored.nodes[0].data.worklogCollapsed, true)
  assert.equal(restored.nodes[0].data.preferredPermissionMode, 'read-only')
  assert.equal(restored.nodes[0].data.modelId, 'gpt-5-codex')
  assert.equal(restored.nextSessionNumber, 8)
  assert.equal(restored.activeProjectId, 'project-1')
  assert.deepEqual(serializeCanvasNode(restored.nodes[0]), state.nodes[0])
})

test('starts legacy agent worklogs collapsed while preserving an explicit expanded choice', () => {
  const callbacks = {
    onStatusChange: () => undefined,
    onConversationId: () => undefined,
    onPreview: () => undefined,
    onWorklogCollapsed: () => undefined,
    onPermissionModeChange: () => undefined,
    onModelChange: () => undefined,
    onResume: () => undefined
  }
  const baseState: WorkspaceState = {
    version: 2,
    projects: [{ id: 'project-1', name: 'ADE', path: 'D:\\Development\\ADE', color: '#71a9ff' }],
    activeProjectId: 'project-1',
    sidebarCollapsed: false,
    nodes: [{
      id: 'node-1',
      kind: 'codex',
      label: 'Codex 1',
      projectId: 'project-1',
      position: { x: 0, y: 0 },
      width: 520,
      height: 340
    }]
  }

  assert.equal(restoreCanvasWorkspace(baseState, callbacks).nodes[0].data.worklogCollapsed, true)

  baseState.nodes[0].worklogCollapsed = false
  const expanded = restoreCanvasWorkspace(baseState, callbacks).nodes[0]
  assert.equal(expanded.data.worklogCollapsed, false)
  assert.equal(serializeCanvasNode(expanded).worklogCollapsed, false)
})

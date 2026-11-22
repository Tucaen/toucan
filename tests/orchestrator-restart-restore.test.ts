import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'
import { createOrchestrationStore } from '../src/main/orchestration-store'
import { createOrchestratorConversations, withOrchestratorRoles } from '../src/main/orchestrator-conversations'
import { createWorkspaceStore } from '../src/main/workspace-store'
import { isTerminalCanvasNode, restoreCanvasWorkspace } from '../src/renderer/src/canvas-workspace'
import { applyPlan, parsePlanInput } from '../src/shared/orchestration'
import type { WorkspaceState, WorkspaceTerminalNode } from '../src/shared/workspace'

// Tucaen/toucan#1, the restart path end to end below the IPC: a canvas saved to disk with an
// orchestrator conversation in a role-less chat - what a History reopen wrote before the fix -
// loads through main's repair and restores as an orchestrator, while a plain chat and a ticket
// session restore exactly as they were saved.

const project = { id: 'project', name: 'Project', path: 'D:\\Project', color: '#71a9ff' }

const callbacks = {
  onStatusChange: () => undefined,
  onConversationId: () => undefined,
  onTitleChange: async () => true,
  onFocusModeChange: () => undefined,
  onDraftChange: () => undefined,
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

const chat = (overrides: Partial<WorkspaceTerminalNode>): WorkspaceTerminalNode => ({
  id: 'chat',
  kind: 'claude',
  label: 'Chat',
  projectId: project.id,
  position: { x: 0, y: 0 },
  width: 750,
  height: 660,
  focusMode: true,
  ...overrides
})

test('a restart restores an orchestrator conversation saved in a role-less chat as an orchestrator', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'toucan-restart-restore-'))
  try {
    const records = createOrchestrationStore({ directory: join(userData, 'orchestrations') })
    const planned = { provider: 'claude' as const, conversationId: 'planned-orchestrator' }
    const plan = parsePlanInput({ task: 'Ship it', targetBranch: 'main', tickets: [{ id: '1', title: 'First' }] }).plan!
    await records.update(planned, () => ({
      value: applyPlan(undefined, plan, { ...planned, projectPath: project.path }, '2026-11-22T10:00:00.000Z').record!,
      result: undefined
    }))
    const conversations = createOrchestratorConversations({
      path: join(userData, 'orchestrator-conversations.json'),
      records
    })
    // An orchestrator that never planned is known by the marker its session wrote when it opened.
    await conversations.remember({ provider: 'codex', conversationId: 'unplanned-orchestrator' })

    const saved: WorkspaceState = {
      version: 3,
      projects: [project],
      activeProjectId: project.id,
      sidebarCollapsed: false,
      worktrees: [],
      nodes: [
        chat({ id: 'planned', conversationId: 'planned-orchestrator' }),
        chat({ id: 'unplanned', kind: 'codex', conversationId: 'unplanned-orchestrator' }),
        chat({ id: 'plain', conversationId: 'plain-chat', focusMode: false }),
        chat({
          id: 'ticket',
          conversationId: 'ticket-conversation',
          focusMode: false,
          orchestratedBy: { nodeId: 'planned', conversationId: 'planned-orchestrator', provider: 'claude' }
        })
      ]
    }
    const workspace = createWorkspaceStore(join(userData, 'prototype-workspace.json'))
    assert.deepEqual(await workspace.save(saved), { ok: true })

    // What `WORKSPACE_CHANNELS.load` answers the renderer with after a restart.
    const loaded = await withOrchestratorRoles(await workspace.load(), conversations)
    const restored = restoreCanvasWorkspace(loaded.state!, callbacks)

    const roles = Object.fromEntries(
      restored.nodes.filter(isTerminalCanvasNode).map((node) => [node.id, node.data.role])
    )
    assert.deepEqual(roles, { planned: 'orchestrator', unplanned: 'orchestrator', plain: undefined, ticket: undefined })
    const ticket = restored.nodes.filter(isTerminalCanvasNode).find((node) => node.id === 'ticket')
    assert.deepEqual(ticket?.data.orchestratedBy, saved.nodes[3].orchestratedBy)
    // The repaired role is valid workspace state, so the renderer's next save writes it back.
    assert.deepEqual(await workspace.save(loaded.state!), { ok: true })
    assert.equal((await workspace.load()).state?.nodes.find((node) => node.id === 'planned')?.role, 'orchestrator')
  } finally {
    rmSync(userData, { recursive: true, force: true })
  }
})

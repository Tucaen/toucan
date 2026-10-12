import { strict as assert } from 'node:assert'
import { test } from 'vitest'
import { createSessionCanvasNode, type TerminalCanvasNode } from '../src/renderer/src/canvas-workspace'
import { projectOfSelection } from '../src/renderer/src/project-sidebar'
import type { WorkspaceProject } from '../src/shared/workspace'

const TOUCAN: WorkspaceProject = { id: 'toucan', name: 'Toucan', path: 'D:\\Development\\toucan', color: '#8ab4f8' }
const OTHER: WorkspaceProject = { id: 'other', name: 'Other', path: 'D:\\Development\\other', color: '#f28b82' }

const noop = (): undefined => undefined
const sessionCallbacks = {
  onStatusChange: noop,
  onConversationId: noop,
  onTitleChange: async () => true,
  onFocusModeChange: noop,
  onDraftChange: noop,
  onPermissionModeChange: noop,
  onModelChange: noop,
  onResume: noop
}

function chat(id: string, project: WorkspaceProject, selected: boolean): TerminalCanvasNode {
  return {
    ...createSessionCanvasNode(
      { id, kind: 'claude', label: id, position: { x: 0, y: 0 }, launchMode: 'new' },
      project,
      undefined,
      sessionCallbacks
    ),
    selected
  }
}

test('a selected chat names its own project', () => {
  assert.equal(projectOfSelection([chat('a', TOUCAN, false), chat('b', OTHER, true)]), 'other')
})

test('several selected nodes of one project still name it', () => {
  assert.equal(projectOfSelection([chat('a', OTHER, true), chat('b', OTHER, true), chat('c', TOUCAN, false)]), 'other')
})

test('nothing selected, or a selection spanning projects, names no project', () => {
  assert.equal(projectOfSelection([chat('a', TOUCAN, false), chat('b', OTHER, false)]), undefined)
  assert.equal(projectOfSelection([chat('a', TOUCAN, true), chat('b', OTHER, true)]), undefined)
})

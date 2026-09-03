import { ReactFlowProvider } from '@xyflow/react'
import { render, screen } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import type { WorkspaceProject, WorkspaceState } from '../src/shared/terminal'
import type {
  CanvasNode,
  TerminalCanvasNode,
  TerminalNodeCallbacks,
  WorktreeCanvasNode,
  WorktreeNodeCallbacks
} from '../src/renderer/src/canvas-workspace'
import {
  isTerminalCanvasNode,
  isWorktreeCanvasNode,
  restoreCanvasWorkspace,
  serializeCanvasNode,
  serializeWorktreeNode
} from '../src/renderer/src/canvas-workspace'
import {
  adoptClaimedWorktrees,
  applyAttachedNodeCounts,
  applyWorktreeClaims
} from '../src/renderer/src/worktree-attachment'
import WorktreeNode from '../src/renderer/src/WorktreeNode'
import WorktreeBadge from '../src/renderer/src/WorktreeBadge'

/**
 * The bug this covers end to end: a Codex node ran the worktree skill, the worktree appeared on
 * the canvas, and the two stayed strangers - the worktree read `0 attached`, the node kept
 * running in the project checkout, and a reload preserved the split. Discovery's claim has to
 * end in a real attachment that survives a save and reload.
 */

const PROJECT: WorkspaceProject = {
  id: 'project-1',
  name: 'ADE',
  path: 'D:\\Development\\ADE',
  color: '#8ab4f8',
  setupCommand: 'npm install'
}
const WORKTREE_PATH = 'D:\\Development\\ADE-worktrees\\feature-thinking-final-presentation'
const BRANCH = 'feature/thinking-final-presentation'

const callbacks: TerminalNodeCallbacks & WorktreeNodeCallbacks = {
  onStatusChange: vi.fn(),
  onConversationId: vi.fn(),
  onTitleChange: vi.fn().mockResolvedValue(true),
  onPreview: vi.fn(),
  onFocusModeChange: vi.fn(),
  onDraftChange: vi.fn(),
  onPermissionModeChange: vi.fn(),
  onModelChange: vi.fn(),
  onResume: vi.fn(),
  onRemoveWorktree: vi.fn(),
  onCreateNodeInWorktree: vi.fn(),
  onRunSetupCommand: vi.fn()
}

/** A Codex node as discovery leaves it: associated with the worktree it claimed, not in it. */
const claimingNode: TerminalCanvasNode = {
  id: 'node-1',
  type: 'terminalNode',
  position: { x: 0, y: 0 },
  data: {
    kind: 'codex',
    sessionId: 'node-1',
    terminalLiveness: 'live',
    label: 'Codex 1',
    projectId: PROJECT.id,
    projectName: PROJECT.name,
    projectPath: PROJECT.path,
    projectColor: PROJECT.color,
    conversationId: '01a05421-cd48-7941-9aa8-15d28400b7b6',
    activeWorktreeId: 'worktree-1',
    activeWorktreeBranch: BRANCH,
    workingDirectory: PROJECT.path,
    focusMode: false,
    dormant: false,
    launchMode: 'resume',
    ...callbacks
  },
  style: { width: 520, height: 340 }
}

const discoveredWorktree: WorktreeCanvasNode = {
  id: 'worktree:worktree-1',
  type: 'worktreeNode',
  deletable: false,
  position: { x: 80, y: 80 },
  data: {
    worktreeId: 'worktree-1',
    branch: BRANCH,
    path: WORKTREE_PATH,
    baseRef: 'main',
    createdAt: '2026-09-03T09:00:00.000Z',
    projectId: PROJECT.id,
    projectName: PROJECT.name,
    projectPath: PROJECT.path,
    projectColor: PROJECT.color,
    attachedNodeCount: 0,
    ...callbacks
  },
  style: { width: 360, height: 232 }
}

function renderWorktree(node: WorktreeCanvasNode): void {
  render(
    <ReactFlowProvider>
      <WorktreeNode
        id={node.id}
        type="worktreeNode"
        selected={false}
        dragging={false}
        zIndex={0}
        isConnectable={false}
        positionAbsoluteX={0}
        positionAbsoluteY={0}
        data={node.data}
      />
    </ReactFlowProvider>
  )
}

beforeEach(() => {
  Object.defineProperty(window, 'worktreeApi', {
    configurable: true,
    value: { status: vi.fn().mockResolvedValue(null) }
  })
})

test('a claimed worktree ends in a real attachment that survives a save and reload', () => {
  const settled = applyAttachedNodeCounts(
    adoptClaimedWorktrees([discoveredWorktree, claimingNode] as CanvasNode[], { 'node-1': 'idle' }),
    [PROJECT]
  )

  const session = settled.filter(isTerminalCanvasNode)[0]
  expect(session.data.worktreeId).toBe('worktree-1')
  expect(session.data.workingDirectory).toBe(WORKTREE_PATH)

  renderWorktree(settled.filter(isWorktreeCanvasNode)[0])
  expect(screen.getByText('1 attached')).toBeInTheDocument()
  render(<WorktreeBadge data={session.data} />)
  expect(screen.getByTitle(`Runs in ${WORKTREE_PATH}`)).toHaveTextContent(BRANCH)

  const saved: WorkspaceState = {
    version: 3,
    projects: [PROJECT],
    activeProjectId: PROJECT.id,
    sidebarCollapsed: false,
    nodes: settled.filter(isTerminalCanvasNode).map(serializeCanvasNode),
    worktrees: settled.filter(isWorktreeCanvasNode).map(serializeWorktreeNode)
  }
  expect(saved.nodes[0]?.worktreeId).toBe('worktree-1')

  const restored = restoreCanvasWorkspace(saved, callbacks)
  const restoredSession = restored.nodes.filter(isTerminalCanvasNode)[0]
  expect(restoredSession.data.worktreeId).toBe('worktree-1')
  expect(restoredSession.data.workingDirectory).toBe(WORKTREE_PATH)
  expect(restoredSession.data.detachedFromWorktree).toBe(false)

  document.body.innerHTML = ''
  renderWorktree(restored.nodes.filter(isWorktreeCanvasNode)[0])
  expect(screen.getByText('1 attached')).toBeInTheDocument()
})

test('a node still working keeps the association and the worktree still reads 0 attached', () => {
  const settled = applyAttachedNodeCounts(
    adoptClaimedWorktrees([discoveredWorktree, claimingNode] as CanvasNode[], { 'node-1': 'working' }),
    [PROJECT]
  )

  const session = settled.filter(isTerminalCanvasNode)[0]
  expect(session.data.worktreeId).toBeUndefined()
  expect(session.data.activeWorktreeId).toBe('worktree-1')
  expect(session.data.workingDirectory).toBe(PROJECT.path)

  renderWorktree(settled.filter(isWorktreeCanvasNode)[0])
  expect(screen.getByText('0 attached')).toBeInTheDocument()
  render(<WorktreeBadge data={session.data} />)
  expect(
    screen.getByTitle(`Working in a worktree on ${BRANCH}; this node still runs in ${PROJECT.path}`)
  ).toBeInTheDocument()
})

test('a claim that arrives after the worktree was already recorded still attaches its node', () => {
  // The real sequence from the report: `git worktree add` finishes, ADE's sweep records the
  // worktree, and only then does the skill write its claim - after the setup command has run.
  // A claim reported for freshly discovered worktrees alone would be dropped precisely here.
  const unlinked: TerminalCanvasNode = {
    ...claimingNode,
    data: { ...claimingNode.data, activeWorktreeId: undefined, activeWorktreeBranch: undefined }
  }
  const recorded = [discoveredWorktree, unlinked] as CanvasNode[]

  const linked = applyWorktreeClaims(recorded, [{ path: WORKTREE_PATH, nodeId: 'node-1' }])
  const settled = applyAttachedNodeCounts(adoptClaimedWorktrees(linked, { 'node-1': 'idle' }), [PROJECT])

  expect(settled.filter(isTerminalCanvasNode)[0].data.worktreeId).toBe('worktree-1')
  renderWorktree(settled.filter(isWorktreeCanvasNode)[0])
  expect(screen.getByText('1 attached')).toBeInTheDocument()
})

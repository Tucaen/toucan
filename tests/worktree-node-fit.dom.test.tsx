import { ReactFlowProvider } from '@xyflow/react'
import { render, screen } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import WorktreeNode from '../src/renderer/src/WorktreeNode'

test('worktree node exposes the fit action in its header', () => {
  Object.defineProperty(window, 'worktreeApi', {
    configurable: true,
    value: { status: vi.fn().mockResolvedValue(null) }
  })
  render(
    <ReactFlowProvider>
      <WorktreeNode
        id="worktree:one"
        type="worktreeNode"
        selected={false}
        dragging={false}
        zIndex={0}
        isConnectable={false}
        positionAbsoluteX={0}
        positionAbsoluteY={0}
        data={{
          worktreeId: 'one',
          branch: 'feature/one',
          path: '/project-one',
          baseRef: 'main',
          createdAt: '2026-09-02T00:00:00.000Z',
          projectId: 'project',
          projectName: 'Project',
          projectPath: '/project',
          projectColor: '#fff',
          attachedNodeCount: 0,
          onRemoveWorktree: vi.fn(),
          onCreateNodeInWorktree: vi.fn(),
          onRunSetupCommand: vi.fn()
        }}
      />
    </ReactFlowProvider>
  )

  expect(screen.getByRole('button', { name: 'Fit to canvas' }).closest('header')).toHaveClass('worktree-node-header')
})

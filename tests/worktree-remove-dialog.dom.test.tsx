import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { WorktreeRemoveDialog, type WorktreeRemovalPrompt } from '../src/renderer/src/WorkspaceDialogs'
import { planWorktreeRemoval } from '../src/renderer/src/worktree-removal'

function prompt(overrides: Partial<WorktreeRemovalPrompt> = {}): WorktreeRemovalPrompt {
  return {
    worktreeId: 'worktree-1',
    branch: 'feature/progress',
    path: '/repo/.worktrees/feature-progress',
    plan: planWorktreeRemoval(0, []),
    busy: false,
    error: null,
    ...overrides
  }
}

describe('worktree removal progress', () => {
  it('shows an immediate non-actionable progress state without claiming inspection has completed', () => {
    render(<WorktreeRemoveDialog prompt={prompt({ busy: true })} onCancel={vi.fn()} onConfirm={vi.fn()} />)

    expect(screen.getByRole('button', { name: 'Removing…' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
    expect(screen.queryByText(/Nothing unique lives here/)).not.toBeInTheDocument()
  })

  it('restores the removal actions and shows the error after a failed request', () => {
    render(
      <WorktreeRemoveDialog
        prompt={prompt({ error: 'The worktree could not be removed.' })}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />
    )

    expect(screen.getByText('The worktree could not be removed.')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Remove worktree' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled()
  })
})

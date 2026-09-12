import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import ProjectRowMenu from '../src/renderer/src/ProjectRowMenu'
import ProjectBranchChip from '../src/renderer/src/ProjectBranchChip'
import type { GitBranchListResult, GitCheckoutResult } from '../src/shared/git-branch'
import type { WorkspaceProject } from '../src/shared/terminal'

// A project's branch is switched from the sidebar row, never from a node: the row's chip opens
// the row menu straight onto the branch page, and that page refuses what git would refuse.

const project = {
  id: 'p1',
  name: 'Toucan',
  path: 'D:/Development/Toucan',
  color: '#71a9ff'
} as WorkspaceProject

const listing: GitBranchListResult = {
  ok: true,
  branches: [
    { name: 'main', current: true, worktreePath: 'D:/Development/Toucan' },
    { name: 'chore/deps', current: false },
    { name: 'feature/login', current: false, worktreePath: 'D:/Development/Toucan-worktrees/feature-login' }
  ]
}

function renderMenu(options: {
  workingSessions?: number
  onSwitchBranch?: (project: WorkspaceProject, branch: string) => Promise<GitCheckoutResult>
  onClose?: () => void
}) {
  const onSwitchBranch = options.onSwitchBranch ?? vi.fn(async () => ({ ok: true }))
  const onClose = options.onClose ?? vi.fn()
  render(
    <ProjectRowMenu
      x={10}
      y={10}
      target={{ kind: 'project', project }}
      initialPage="branches"
      groups={[]}
      onClose={onClose}
      onColorChange={vi.fn()}
      onMoveToGroup={vi.fn()}
      onCreateGroup={vi.fn()}
      onRunCommand={vi.fn()}
      onRenameGroup={vi.fn()}
      onDeleteGroup={vi.fn()}
      onListBranches={vi.fn(async () => listing)}
      onSwitchBranch={onSwitchBranch}
      workingSessions={() => options.workingSessions ?? 0}
    />
  )
  return { onSwitchBranch, onClose }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('the branch page of the project row menu', () => {
  test('lists local branches, marks the current one and greys out those a worktree holds', async () => {
    renderMenu({})

    const current = await screen.findByRole('menuitemradio', { name: /main/ })
    expect(current).toHaveAttribute('aria-checked', 'true')
    expect(current).toBeDisabled()

    const held = screen.getByRole('menuitemradio', { name: /feature\/login/ })
    expect(held).toBeDisabled()
    expect(held.title).toContain('Checked out in D:/Development/Toucan-worktrees/feature-login')

    expect(screen.getByRole('menuitemradio', { name: /chore\/deps/ })).toBeEnabled()
  })

  test('picking a free branch checks it out and closes the menu', async () => {
    const { onSwitchBranch, onClose } = renderMenu({})

    fireEvent.click(await screen.findByRole('menuitemradio', { name: /chore\/deps/ }))

    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(onSwitchBranch).toHaveBeenCalledWith(project, 'chore/deps')
  })

  test('shows the refusal from git beside the list instead of closing', async () => {
    const onClose = vi.fn()
    renderMenu({
      onClose,
      onSwitchBranch: vi.fn(async () => ({ ok: false, message: 'Your local changes would be overwritten' }))
    })

    fireEvent.click(await screen.findByRole('menuitemradio', { name: /chore\/deps/ }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Your local changes would be overwritten')
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByRole('menuitemradio', { name: /chore\/deps/ })).toBeEnabled()
  })

  test('refuses every branch while a session is working in the checkout', async () => {
    renderMenu({ workingSessions: 2 })

    const free = await screen.findByRole('menuitemradio', { name: /chore\/deps/ })
    expect(free).toBeDisabled()
    expect(screen.getByText(/2 sessions are working in this checkout/)).toBeInTheDocument()
  })
})

describe('the project row branch chip', () => {
  test('names the checkout branch and opens the switcher anchored to itself', async () => {
    Object.defineProperty(window, 'worktreeApi', {
      configurable: true,
      value: { currentBranch: vi.fn(async () => ({ isRepository: true, branch: 'main' })) }
    })
    const onOpen = vi.fn()
    render(<ProjectBranchChip directory={project.path} revision={0} onOpen={onOpen} />)

    const chip = await screen.findByRole('button', { name: /main/ })
    await act(async () => {
      fireEvent.click(chip)
    })
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ left: expect.any(Number) }))
  })

  test('renders nothing for a directory that is not a repository', async () => {
    Object.defineProperty(window, 'worktreeApi', {
      configurable: true,
      value: { currentBranch: vi.fn(async () => ({ isRepository: false })) }
    })
    const { container } = render(<ProjectBranchChip directory={project.path} revision={0} onOpen={vi.fn()} />)
    await waitFor(() => expect(window.worktreeApi.currentBranch).toHaveBeenCalled())
    expect(container.querySelector('.project-branch')).toBeNull()
  })
})

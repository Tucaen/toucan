import { ReactFlowProvider } from '@xyflow/react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import type { GitDiffSummary, GitFileDiff, GitFileDiffRequest } from '../src/shared/git-diff'
import type { DiffCanvasNode } from '../src/renderer/src/canvas-workspace'
import DiffNode from '../src/renderer/src/DiffNode'
import { OpenFileContext } from '../src/renderer/src/open-file-context'
import WorktreeNode from '../src/renderer/src/WorktreeNode'

/*
 * The diff node (issue #144): a rail of changed files against the recorded base, hunks for the
 * file the reader opens (read one file at a time), an explicit Refresh, and an honest state for a
 * directory that is not a repository. Also the worktree node header action that opens one.
 */

const WORKTREE = 'D:\\Development\\Toucan-worktrees\\feature-login'

const summary: GitDiffSummary = {
  ok: true,
  branch: 'feature/login',
  files: [
    { path: 'docs/notes.md', status: 'untracked' },
    { path: 'src/a.ts', status: 'modified', added: 3, deleted: 1, binary: false },
    { path: 'img.png', status: 'modified', binary: true, added: 0, deleted: 0 }
  ]
}

const hunks: GitFileDiff = {
  ok: true,
  binary: false,
  hunks: [
    {
      header: '@@ -1,2 +1,2 @@',
      oldStart: 1,
      oldLines: 2,
      newStart: 1,
      newLines: 2,
      lines: [
        { kind: 'context', text: 'const a = 1' },
        { kind: 'removed', text: 'const b = 2' },
        { kind: 'added', text: 'const b = 3' }
      ]
    }
  ]
}

function stubApi(
  diff: GitDiffSummary,
  diffFile: (request: GitFileDiffRequest) => GitFileDiff = () => hunks
): { diff: ReturnType<typeof vi.fn>; diffFile: ReturnType<typeof vi.fn> } {
  const api = {
    diff: vi.fn(async () => diff),
    diffFile: vi.fn(async (request: GitFileDiffRequest) => diffFile(request))
  }
  Object.defineProperty(window, 'worktreeApi', { configurable: true, writable: true, value: api })
  Object.defineProperty(window, 'terminalApi', { configurable: true, writable: true, value: { copyText: vi.fn() } })
  return api
}

afterEach(() => {
  Reflect.deleteProperty(window, 'worktreeApi')
  Reflect.deleteProperty(window, 'terminalApi')
})

function renderNode(data: Partial<DiffCanvasNode['data']> = {}): {
  onSelectDiffPath: ReturnType<typeof vi.fn>
  rerender: (data: Partial<DiffCanvasNode['data']>) => void
} {
  const onSelectDiffPath = vi.fn()
  const element = (extra: Partial<DiffCanvasNode['data']>): JSX.Element => (
    <ReactFlowProvider>
      <OpenFileContext.Provider value={vi.fn()}>
        <DiffNode
          id="diff-1"
          type="diffNode"
          selected={false}
          dragging={false}
          zIndex={0}
          isConnectable={false}
          positionAbsoluteX={0}
          positionAbsoluteY={0}
          data={
            {
              projectId: 'project',
              projectName: 'Toucan',
              projectPath: 'D:\\Development\\Toucan',
              projectColor: '#71a9ff',
              worktreeId: 'worktree-1',
              label: 'feature/login',
              path: WORKTREE,
              baseRef: 'main',
              onSelectDiffPath,
              ...data,
              ...extra
            } as DiffCanvasNode['data']
          }
        />
      </OpenFileContext.Provider>
    </ReactFlowProvider>
  )
  const { rerender } = render(element({}))
  return { onSelectDiffPath, rerender: (extra) => rerender(element(extra)) }
}

test('lists the changed files with status and counts, and names the branch and base', async () => {
  const api = stubApi(summary)
  renderNode()

  await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(3))
  expect(api.diff).toHaveBeenCalledWith({ path: WORKTREE, baseRef: 'main' })
  expect(screen.getByText('feature/login against main')).toBeInTheDocument()
  expect(screen.getByText('3 files')).toBeInTheDocument()
  const modified = screen.getByRole('option', { name: /src\/a\.ts/ })
  expect(modified).toHaveTextContent('M')
  expect(modified).toHaveTextContent('+3 −1')
  expect(screen.getByRole('option', { name: /docs\/notes\.md/ })).toHaveTextContent('?')
  // Nothing was opened, so no file's hunks were read.
  expect(api.diffFile).not.toHaveBeenCalled()
  expect(screen.getByText('Select a file to see its changes.')).toBeInTheDocument()
})

test('selecting a file reads only that file and renders its hunk with both line numbers', async () => {
  const api = stubApi(summary)
  const { onSelectDiffPath, rerender } = renderNode()
  await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(3))

  fireEvent.click(screen.getByRole('option', { name: /src\/a\.ts/ }))
  expect(onSelectDiffPath).toHaveBeenCalledWith('diff-1', 'src/a.ts')
  expect(api.diffFile).toHaveBeenCalledTimes(1)
  expect(api.diffFile).toHaveBeenCalledWith({
    path: WORKTREE,
    baseRef: 'main',
    file: { path: 'src/a.ts', status: 'modified', added: 3, deleted: 1, binary: false }
  })
  // The workspace records the choice and hands it back as node data.
  rerender({ selectedPath: 'src/a.ts' })

  await waitFor(() => expect(screen.getByText('@@ -1,2 +1,2 @@')).toBeInTheDocument())
  // New node data must not restart the review: the list and the file are read exactly once each.
  expect(api.diff).toHaveBeenCalledTimes(1)
  expect(api.diffFile).toHaveBeenCalledTimes(1)
  // The hunk's path row can open the file as a node when a canvas is behind the diff node.
  expect(screen.getByRole('button', { name: 'Open' })).toBeInTheDocument()
  expect(screen.getByRole('option', { name: /src\/a\.ts/ })).toHaveAttribute('aria-selected', 'true')
  const lines = document.querySelectorAll('.file-op-line')
  expect(lines).toHaveLength(3)
  expect(lines[1]).toHaveAttribute('data-tone', 'old')
  expect(lines[1].textContent).toContain('const b = 2')
  expect(lines[2]).toHaveAttribute('data-tone', 'new')
  // Removed lines number only the old side, added lines only the new side.
  const numbers = (line: Element): string[] =>
    [...line.querySelectorAll('.file-op-line-number')].map((cell) => cell.textContent ?? '')
  expect(numbers(lines[0])).toEqual(['1', '1'])
  expect(numbers(lines[1])).toEqual(['2', ''])
  expect(numbers(lines[2])).toEqual(['', '2'])
  // The absolute path is offered for copying, joined with the checkout's own separator.
  expect(screen.getByTitle(`${WORKTREE}\\src\\a.ts`)).toBeInTheDocument()
})

test('a binary file says so instead of showing hunks', async () => {
  stubApi(summary, () => ({ ok: true, binary: true, hunks: [] }))
  renderNode({ selectedPath: 'img.png' })

  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/Binary file/))
  expect(document.querySelector('.file-op-line')).toBeNull()
})

test('Refresh re-reads the file list and re-reads the open file only while it is still changed', async () => {
  const api = stubApi(summary)
  const { onSelectDiffPath } = renderNode({ selectedPath: 'src/a.ts' })
  await waitFor(() => expect(screen.getByText('@@ -1,2 +1,2 @@')).toBeInTheDocument())
  expect(api.diff).toHaveBeenCalledTimes(1)
  expect(api.diffFile).toHaveBeenCalledTimes(1)

  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
  await waitFor(() => expect(api.diff).toHaveBeenCalledTimes(2))
  await waitFor(() => expect(api.diffFile).toHaveBeenCalledTimes(2))
  expect(onSelectDiffPath).not.toHaveBeenCalled()

  // The file was committed or reverted: the list no longer carries it, so the selection is dropped
  // rather than jumping to another file.
  const remaining = summary.ok ? [summary.files[0]] : []
  api.diff.mockResolvedValue({ ok: true, branch: 'feature/login', files: remaining })
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
  await waitFor(() => expect(onSelectDiffPath).toHaveBeenCalledWith('diff-1', undefined))
  expect(api.diffFile).toHaveBeenCalledTimes(2)
})

test('a directory that is not a repository, or no changes at all, is reported in place', async () => {
  stubApi({ ok: false, reason: 'not-a-repository', message: 'nope' })
  const { rerender } = renderNode()
  await waitFor(() =>
    expect(screen.getByRole('status')).toHaveTextContent(
      'This directory is not a git repository, so there is nothing to diff.'
    )
  )
  expect(screen.queryByRole('listbox')).toBeNull()
  // With no branch to report the header falls back to the node's own label.
  expect(screen.getByText('feature/login against main')).toBeInTheDocument()

  Object.defineProperty(window, 'worktreeApi', {
    configurable: true,
    writable: true,
    value: { diff: vi.fn(async () => ({ ok: true, files: [] })), diffFile: vi.fn() }
  })
  rerender({ path: 'D:\\Development\\Toucan', baseRef: 'HEAD', label: 'Toucan', worktreeId: undefined })
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('No changes against HEAD.'))
})

test('the worktree node header offers Diff, which asks the canvas for a review of that worktree', () => {
  Object.defineProperty(window, 'worktreeApi', {
    configurable: true,
    writable: true,
    value: { status: vi.fn().mockResolvedValue(null) }
  })
  const onOpenDiff = vi.fn()
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
          path: WORKTREE,
          baseRef: 'main',
          createdAt: '2026-09-02T00:00:00.000Z',
          projectId: 'project',
          projectName: 'Project',
          projectPath: 'D:\\Development\\Toucan',
          projectColor: '#fff',
          attachedNodeCount: 0,
          onRemoveWorktree: vi.fn(),
          onCreateNodeInWorktree: vi.fn(),
          onRunSetupCommand: vi.fn(),
          onOpenDiff
        }}
      />
    </ReactFlowProvider>
  )
  const button = screen.getByRole('button', { name: 'Diff' })
  expect(button.closest('header')).toHaveClass('worktree-node-header')
  expect(button).toHaveAttribute('title', "Review this worktree's changes against main")
  fireEvent.click(button)
  expect(onOpenDiff).toHaveBeenCalledWith('one')
})

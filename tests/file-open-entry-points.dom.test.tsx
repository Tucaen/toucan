import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import type { WorkspaceFileIndex } from '../src/shared/workspace-files'
import { FileOperationBody } from '../src/renderer/src/FileOperationCard'
import FilePickerDialog from '../src/renderer/src/FilePickerDialog'
import { OpenFileContext } from '../src/renderer/src/open-file-context'

/*
 * The two ways a file reaches the canvas (issue #143): "Open" on a transcript's file card, which
 * only appears when a canvas is behind the card, and the context menu's picker, which lists the
 * same git-aware index the composer's `@` mention uses.
 */

afterEach(() => {
  Reflect.deleteProperty(window, 'shellApi')
  Reflect.deleteProperty(window, 'workspaceFilesApi')
})

const operation = { kind: 'read' as const, path: 'D:\\Development\\Toucan\\docs\\plan.md' }

test('a file card offers Open only when something can open it', () => {
  Object.defineProperty(window, 'shellApi', { configurable: true, writable: true, value: { copyText: vi.fn() } })
  const { unmount } = render(<FileOperationBody operation={operation} blocks={[]} />)
  expect(screen.queryByRole('button', { name: 'Open' })).toBeNull()
  unmount()

  const openFile = vi.fn()
  render(
    <OpenFileContext.Provider value={openFile}>
      <FileOperationBody operation={operation} blocks={[]} />
    </OpenFileContext.Provider>
  )
  fireEvent.click(screen.getByRole('button', { name: 'Open' }))
  expect(openFile).toHaveBeenCalledWith('D:\\Development\\Toucan\\docs\\plan.md')
})

test('the picker lists files only, narrows as you type, and opens the absolute path', async () => {
  const index: WorkspaceFileIndex = {
    root: 'D:\\Development\\Toucan',
    gitignored: true,
    truncated: false,
    entries: [
      { path: 'docs', directory: true },
      { path: 'docs/plans/tickets.md', directory: false },
      { path: 'src/main/index.ts', directory: false },
      { path: 'README.md', directory: false }
    ]
  }
  Object.defineProperty(window, 'workspaceFilesApi', {
    configurable: true,
    writable: true,
    value: { index: vi.fn(async () => index) }
  })
  const onOpen = vi.fn()
  // A JSX attribute string keeps its backslashes literally, so the root is passed as an expression.
  render(<FilePickerDialog projectName="Toucan" root={'D:\\Development\\Toucan'} onCancel={vi.fn()} onOpen={onOpen} />)

  await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(3))
  expect(screen.queryByText('docs')).toBeNull()
  expect(screen.getByText(/Files git ignores are hidden/)).toBeInTheDocument()

  const search = screen.getByRole('searchbox', { name: 'Search files' })
  fireEvent.change(search, { target: { value: 'tickets' } })
  expect(screen.getAllByRole('option')).toHaveLength(1)
  fireEvent.keyDown(search, { key: 'Enter' })
  expect(onOpen).toHaveBeenCalledWith('D:\\Development\\Toucan\\docs\\plans\\tickets.md')

  fireEvent.change(search, { target: { value: 'index' } })
  fireEvent.click(screen.getByRole('button', { name: 'src/main/index.ts' }))
  expect(onOpen).toHaveBeenLastCalledWith('D:\\Development\\Toucan\\src\\main\\index.ts')
})

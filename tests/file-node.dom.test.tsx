import { EditorView } from '@codemirror/view'
import { ReactFlowProvider } from '@xyflow/react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import type { FileReadResult, FileWriteRequest, FileWriteResult } from '../src/shared/file-view'
import type { FileCanvasNode } from '../src/renderer/src/canvas-workspace'
import FileNode from '../src/renderer/src/FileNode'

/*
 * The file node (issues #143 and #148): one project file on the canvas, Markdown rendered by default
 * with a raw toggle, everything else raw only, live-updating, honest about a file that is not
 * there - and editable, with disk as the truth when the two disagree.
 */

const PATH = 'D:\\Development\\Toucan\\docs\\plan.md'
const TEXT_PATH = 'D:\\Development\\Toucan\\notes.txt'

interface Stub {
  read: ReturnType<typeof vi.fn>
  write: ReturnType<typeof vi.fn>
  watch: ReturnType<typeof vi.fn>
  unwatch: ReturnType<typeof vi.fn>
  emitChange: (path: string) => void
  copyText: ReturnType<typeof vi.fn>
  showItemInFolder: ReturnType<typeof vi.fn>
}

function stubApis(result: FileReadResult, write?: (request: FileWriteRequest) => Promise<FileWriteResult>): Stub {
  let listener: ((path: string) => void) | null = null
  const read = vi.fn(async () => result)
  const writeStub = vi.fn(
    write ?? (async (request: FileWriteRequest) => ({ ok: true, mtime: 'saved', size: request.content.length }))
  )
  const watch = vi.fn(async () => undefined)
  const unwatch = vi.fn(async () => undefined)
  const copyText = vi.fn()
  const showItemInFolder = vi.fn(async () => undefined)
  Object.defineProperty(window, 'fileViewApi', {
    configurable: true,
    writable: true,
    value: {
      read,
      write: writeStub,
      watch,
      unwatch,
      onChange: (callback: (path: string) => void) => {
        listener = callback
        return () => {
          listener = null
        }
      }
    }
  })
  Object.defineProperty(window, 'terminalApi', {
    configurable: true,
    writable: true,
    value: { copyText, showItemInFolder, openExternal: vi.fn(async () => undefined) }
  })
  return { read, write: writeStub, watch, unwatch, emitChange: (path) => listener?.(path), copyText, showItemInFolder }
}

afterEach(() => {
  Reflect.deleteProperty(window, 'fileViewApi')
  Reflect.deleteProperty(window, 'terminalApi')
})

const ok = (content: string, extra: Partial<Extract<FileReadResult, { ok: true }>> = {}): FileReadResult => ({
  ok: true,
  content,
  truncated: false,
  size: content.length,
  mtime: '2026-09-05T09:00:00.000Z',
  binary: false,
  ...extra
})

const node = (
  data: Partial<FileCanvasNode['data']>,
  onViewModeChange: ReturnType<typeof vi.fn>,
  onRequestFilePath: ReturnType<typeof vi.fn>,
  onPathChange: ReturnType<typeof vi.fn>
): JSX.Element => (
  <ReactFlowProvider>
    <FileNode
      id="file-1"
      type="fileNode"
      selected={false}
      dragging={false}
      zIndex={0}
      isConnectable={false}
      positionAbsoluteX={0}
      positionAbsoluteY={0}
      data={
        {
          path: PATH,
          view: 'rendered',
          projectId: 'project',
          projectName: 'Toucan',
          projectPath: 'D:\\Development\\Toucan',
          projectColor: '#71a9ff',
          onViewModeChange,
          onRequestFilePath,
          onPathChange,
          ...data
        } as FileCanvasNode['data']
      }
    />
  </ReactFlowProvider>
)

function renderNode(data: Partial<FileCanvasNode['data']> = {}): {
  onViewModeChange: ReturnType<typeof vi.fn>
  onRequestFilePath: ReturnType<typeof vi.fn>
  onPathChange: ReturnType<typeof vi.fn>
  unmount: () => void
  rerender: (data: Partial<FileCanvasNode['data']>) => void
} {
  const onViewModeChange = vi.fn()
  const onRequestFilePath = vi.fn(async () => null)
  const onPathChange = vi.fn()
  const { unmount, rerender } = render(node(data, onViewModeChange, onRequestFilePath, onPathChange))
  return {
    onViewModeChange,
    onRequestFilePath,
    onPathChange,
    unmount,
    rerender: (next) => rerender(node(next, onViewModeChange, onRequestFilePath, onPathChange))
  }
}

/** The mounted CodeMirror view, found the way CodeMirror itself offers rather than through React. */
async function editor(): Promise<EditorView> {
  return waitFor(() => {
    const element = document.querySelector('.cm-editor')
    const view = element && EditorView.findFromDOM(element as HTMLElement)
    if (!view) throw new Error('no editor mounted')
    return view
  })
}

/** Types by dispatching to the editor, which is what a keystroke ends up as. */
function type(view: EditorView, text: string, at = view.state.doc.length): void {
  act(() => view.dispatch({ changes: { from: at, insert: text } }))
}

const saveButton = (): HTMLElement => screen.getByRole('button', { name: 'Save' })

test('the filename and path change the displayed file without replacing the node', async () => {
  stubApis(ok('# Plan\n'))
  const nextPath = 'D:\\Development\\Toucan\\docs\\next.md'
  const onRequestFilePath = vi.fn(async () => nextPath)
  const { onPathChange } = renderNode({ onRequestFilePath } as Partial<FileCanvasNode['data']>)

  fireEvent.click(screen.getByRole('button', { name: 'Change displayed file' }))

  await waitFor(() => expect(onRequestFilePath).toHaveBeenCalledWith('file-1'))
  expect(onPathChange).toHaveBeenCalledWith('file-1', nextPath)
})

test('a late read from the old path cannot replace the newly selected file', async () => {
  let finishOldRead: (result: FileReadResult) => void = () => {}
  const oldRead = new Promise<FileReadResult>((resolve) => {
    finishOldRead = resolve
  })
  const stub = stubApis(ok('fallback\n'))
  stub.read.mockReturnValueOnce(oldRead).mockResolvedValueOnce(ok('new file\n', { mtime: 'new-file-mtime' }))
  const nextPath = 'D:\\Development\\Toucan\\docs\\next.txt'
  const onRequestFilePath = vi.fn(async () => nextPath)
  const { onPathChange, rerender } = renderNode({ path: TEXT_PATH, onRequestFilePath } as Partial<
    FileCanvasNode['data']
  >)

  fireEvent.click(screen.getByRole('button', { name: 'Change displayed file' }))
  await waitFor(() => expect(onPathChange).toHaveBeenCalledWith('file-1', nextPath))
  rerender({ path: nextPath, view: 'raw' })
  const view = await editor()
  await waitFor(() => expect(view.state.doc.toString()).toBe('new file\n'))

  await act(async () => finishOldRead(ok('old file\n', { mtime: 'old-file-mtime' })))
  expect(view.state.doc.toString()).toBe('new file\n')

  type(view, 'edited\n')
  fireEvent.click(saveButton())
  await waitFor(() => expect(stub.write).toHaveBeenCalledTimes(1))
  expect(stub.write).toHaveBeenCalledWith({
    path: nextPath,
    content: 'new file\nedited\n',
    baseMtime: 'new-file-mtime'
  })
})

test.each([
  ['a cancelled picker', null],
  ['selecting the same file', 'd:/development/toucan/NOTES.txt']
])('%s leaves the current file and draft untouched', async (_case, nextPath) => {
  stubApis(ok('old\n'))
  const onRequestFilePath = vi.fn(async () => nextPath)
  const { onPathChange } = renderNode({ path: TEXT_PATH, onRequestFilePath } as Partial<FileCanvasNode['data']>)
  const view = await editor()
  type(view, 'pending\n')

  fireEvent.click(screen.getByRole('button', { name: 'Change displayed file' }))

  await waitFor(() => expect(onRequestFilePath).toHaveBeenCalledWith('file-1'))
  expect(screen.queryByRole('dialog', { name: 'Unsaved changes' })).toBeNull()
  expect(onPathChange).not.toHaveBeenCalled()
  expect(view.state.doc.toString()).toBe('old\npending\n')
})

test('aborting a file change keeps the old file and its pending edits', async () => {
  stubApis(ok('old\n'))
  const nextPath = 'D:\\Development\\Toucan\\docs\\next.md'
  const onRequestFilePath = vi.fn(async () => nextPath)
  const { onPathChange } = renderNode({ path: TEXT_PATH, onRequestFilePath } as Partial<FileCanvasNode['data']>)
  const view = await editor()
  type(view, 'pending\n')

  fireEvent.click(screen.getByRole('button', { name: 'Change displayed file' }))
  const dialog = await screen.findByRole('dialog', { name: 'Unsaved changes' })
  expect(onPathChange).not.toHaveBeenCalled()
  const abort = screen.getByRole('button', { name: 'Abort' })
  expect(abort).toHaveFocus()
  fireEvent.keyDown(abort, { key: 'Tab', shiftKey: true })
  expect(screen.getByRole('button', { name: 'Save and switch' })).toHaveFocus()
  fireEvent.keyDown(screen.getByRole('button', { name: 'Save and switch' }), { key: 'Tab' })
  expect(abort).toHaveFocus()
  fireEvent.click(abort)

  await waitFor(() => expect(dialog).not.toBeInTheDocument())
  expect(screen.getByRole('button', { name: 'Change displayed file' })).toHaveFocus()
  expect(onPathChange).not.toHaveBeenCalled()
  expect(view.state.doc.toString()).toBe('old\npending\n')
  expect(screen.getByLabelText('Unsaved changes')).toBeInTheDocument()
})

test('discarding pending edits switches to the selected file without saving', async () => {
  const stub = stubApis(ok('old\n'))
  const nextPath = 'D:\\Development\\Toucan\\docs\\next.md'
  const onRequestFilePath = vi.fn(async () => nextPath)
  const { onPathChange } = renderNode({ path: TEXT_PATH, onRequestFilePath } as Partial<FileCanvasNode['data']>)
  const view = await editor()
  type(view, 'pending\n')

  fireEvent.click(screen.getByRole('button', { name: 'Change displayed file' }))
  await screen.findByRole('dialog', { name: 'Unsaved changes' })
  fireEvent.click(screen.getByRole('button', { name: 'Discard and switch' }))

  expect(stub.write).not.toHaveBeenCalled()
  expect(onPathChange).toHaveBeenCalledWith('file-1', nextPath)
  await waitFor(() => expect(screen.queryByLabelText('Unsaved changes')).toBeNull())
  expect(view.state.doc.toString()).toBe('old\n')
})

test('saving pending edits writes the old file before switching to the selected file', async () => {
  const stub = stubApis(ok('old\n'))
  const nextPath = 'D:\\Development\\Toucan\\docs\\next.md'
  const onRequestFilePath = vi.fn(async () => nextPath)
  const { onPathChange } = renderNode({ path: TEXT_PATH, onRequestFilePath } as Partial<FileCanvasNode['data']>)
  const view = await editor()
  type(view, 'pending\n')

  fireEvent.click(screen.getByRole('button', { name: 'Change displayed file' }))
  await screen.findByRole('dialog', { name: 'Unsaved changes' })
  fireEvent.click(screen.getByRole('button', { name: 'Save and switch' }))

  await waitFor(() =>
    expect(stub.write).toHaveBeenCalledWith({
      path: TEXT_PATH,
      content: 'old\npending\n',
      baseMtime: '2026-09-05T09:00:00.000Z'
    })
  )
  expect(onPathChange).toHaveBeenCalledWith('file-1', nextPath)
})

test('a file-change prompt opened during a save keeps keyboard focus inside until actions return', async () => {
  let finish: (result: FileWriteResult) => void = () => {}
  stubApis(ok('old\n'), () => new Promise<FileWriteResult>((resolve) => (finish = resolve)))
  const nextPath = 'D:\\Development\\Toucan\\docs\\next.md'
  const onRequestFilePath = vi.fn(async () => nextPath)
  const { onPathChange } = renderNode({ path: TEXT_PATH, onRequestFilePath } as Partial<FileCanvasNode['data']>)
  const view = await editor()
  type(view, 'pending\n')
  fireEvent.click(saveButton())

  fireEvent.click(screen.getByRole('button', { name: 'Change displayed file' }))
  await screen.findByRole('dialog', { name: 'Unsaved changes' })
  const panel = document.querySelector('.worktree-dialog') as HTMLElement
  await waitFor(() => expect(panel).toHaveFocus())
  fireEvent.keyDown(panel, { key: 'Tab' })
  expect(panel).toHaveFocus()

  await act(async () => finish({ ok: true, mtime: 'saved', size: 12 }))
  await waitFor(() => expect(screen.getByRole('button', { name: 'Abort' })).toHaveFocus())
  fireEvent.click(screen.getByRole('button', { name: 'Switch' }))
  expect(onPathChange).toHaveBeenCalledWith('file-1', nextPath)
})

test('edits made while save-and-switch is writing must be saved before the node switches', async () => {
  let finish: (result: FileWriteResult) => void = () => {}
  const stub = stubApis(ok('old\n'), () => new Promise<FileWriteResult>((resolve) => (finish = resolve)))
  const nextPath = 'D:\\Development\\Toucan\\docs\\next.md'
  const onRequestFilePath = vi.fn(async () => nextPath)
  const { onPathChange } = renderNode({ path: TEXT_PATH, onRequestFilePath } as Partial<FileCanvasNode['data']>)
  const view = await editor()
  type(view, 'pending\n')

  fireEvent.click(screen.getByRole('button', { name: 'Change displayed file' }))
  await screen.findByRole('dialog', { name: 'Unsaved changes' })
  fireEvent.click(screen.getByRole('button', { name: 'Save and switch' }))
  await waitFor(() => expect(stub.write).toHaveBeenCalledTimes(1))
  await waitFor(() => expect(document.querySelector('.worktree-dialog')).toHaveFocus())

  type(view, 'new\n')
  await act(async () => finish({ ok: true, mtime: 'saved-once', size: 12 }))

  expect(onPathChange).not.toHaveBeenCalled()
  expect(screen.getByRole('dialog', { name: 'Unsaved changes' })).toBeInTheDocument()
  await waitFor(() => expect(screen.getByRole('button', { name: 'Abort' })).toHaveFocus())
  fireEvent.click(screen.getByRole('button', { name: 'Save and switch' }))
  await waitFor(() => expect(stub.write).toHaveBeenCalledTimes(2))
  expect(stub.write.mock.calls[1][0]).toMatchObject({ content: 'old\npending\nnew\n', baseMtime: 'saved-once' })
  await act(async () => finish({ ok: true, mtime: 'saved-twice', size: 16 }))

  await waitFor(() => expect(onPathChange).toHaveBeenCalledWith('file-1', nextPath))
})

test('a failed save aborts the switch and leaves the pending edits on the old file', async () => {
  const stub = stubApis(ok('old\n'), async () => ({ ok: false, reason: 'unwritable', message: 'Access denied.' }))
  const nextPath = 'D:\\Development\\Toucan\\docs\\next.md'
  const onRequestFilePath = vi.fn(async () => nextPath)
  const { onPathChange } = renderNode({ path: TEXT_PATH, onRequestFilePath } as Partial<FileCanvasNode['data']>)
  const view = await editor()
  type(view, 'pending\n')

  fireEvent.click(screen.getByRole('button', { name: 'Change displayed file' }))
  await screen.findByRole('dialog', { name: 'Unsaved changes' })
  fireEvent.click(screen.getByRole('button', { name: 'Save and switch' }))

  expect(await screen.findByRole('alert')).toHaveTextContent('Access denied.')
  expect(screen.queryByRole('dialog', { name: 'Unsaved changes' })).toBeNull()
  expect(onPathChange).not.toHaveBeenCalled()
  expect(view.state.doc.toString()).toBe('old\npending\n')
  expect(stub.write).toHaveBeenCalledTimes(1)
})

test('renders Markdown by default and offers the raw view through the node, not local state', async () => {
  stubApis(ok('# Plan\n\nRead **this**.\n'))
  const { onViewModeChange } = renderNode()

  expect(await screen.findByRole('heading', { level: 1, name: 'Plan' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Rendered' })).toHaveAttribute('aria-pressed', 'true')

  // The raw view is where editing happens, so for an editable file the toggle says so.
  fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
  expect(onViewModeChange).toHaveBeenCalledWith('file-1', 'raw')
  // Clicking the already-active view is not a change.
  fireEvent.click(screen.getByRole('button', { name: 'Rendered' }))
  expect(onViewModeChange).toHaveBeenCalledTimes(1)
})

test('the raw view is a CodeMirror editor with numbered lines and a grammar picked from the file name', async () => {
  stubApis(ok('const a = 1\nconst b = 2\n'))
  renderNode({ path: 'D:\\Development\\Toucan\\src\\index.tsx', view: 'rendered' })

  const view = await editor()
  expect(view.state.doc.toString()).toBe('const a = 1\nconst b = 2\n')
  expect(screen.queryByRole('button', { name: 'Rendered' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull()
  expect(document.querySelector('.file-node-body')?.getAttribute('data-view')).toBe('raw')
  expect(document.querySelector('.cm-lineNumbers')).not.toBeNull()
  // `.tsx` is a grammar lowlight never had; CodeMirror's language data loads it and tokens get
  // stable `tok-*` classes the stylesheet themes.
  await waitFor(() => expect(document.querySelector('.cm-content .tok-keyword')).not.toBeNull())
  expect(document.querySelectorAll('.cm-line')[1].textContent).toBe('const b = 2')
})

test('a Markdown file the reader switched to raw comes back raw', async () => {
  stubApis(ok('# Plan\n'))
  renderNode({ view: 'raw' })
  const view = await editor()
  expect(view.state.doc.toString()).toBe('# Plan\n')
  expect(screen.queryByRole('heading')).toBeNull()
  expect(screen.getByRole('button', { name: 'Edit' })).toHaveAttribute('aria-pressed', 'true')
})

test('a file that is gone keeps its node and says so', async () => {
  stubApis({ ok: false, reason: 'not-found', message: 'gone' })
  renderNode()
  const notice = await screen.findByRole('status')
  expect(notice).toHaveAttribute('data-reason', 'not-found')
  expect(notice.textContent).toMatch(/not on disk/)
  // The header still names the file, so the reader knows what the empty node was showing.
  expect(screen.getByText('plan.md')).toBeInTheDocument()
  expect(document.querySelector('.cm-editor')).toBeNull()
})

test('the header shortens the path against the project and offers Copy path and Reveal', async () => {
  const stub = stubApis(ok('x'))
  renderNode()
  await screen.findByText('x')
  expect(screen.getByText('docs/plan.md')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Copy path' }))
  expect(stub.copyText).toHaveBeenCalledWith(PATH)
  fireEvent.click(screen.getByRole('button', { name: 'Reveal' }))
  expect(stub.showItemInFolder).toHaveBeenCalledWith(PATH)
  expect(screen.getByRole('button', { name: 'Fit to canvas' })).toBeInTheDocument()
})

test('a change to the watched file re-reads it, and unmounting stops the watch', async () => {
  const stub = stubApis(ok('before'))
  const { unmount } = renderNode({ view: 'raw' })
  const view = await editor()
  expect(view.state.doc.toString()).toBe('before')
  expect(stub.watch).toHaveBeenCalledWith(PATH)

  stub.read.mockResolvedValue(ok('after', { mtime: '2026-09-05T09:01:00.000Z' }))
  // A different file changing is not this node's business.
  act(() => stub.emitChange('D:\\Development\\Toucan\\docs\\other.md'))
  expect(stub.read).toHaveBeenCalledTimes(1)
  // The same file under another spelling of its path is.
  act(() => stub.emitChange('d:/development/toucan/docs/PLAN.md'))
  await waitFor(() => expect(view.state.doc.toString()).toBe('after'))

  unmount()
  expect(stub.unwatch).toHaveBeenCalledWith(PATH)
})

test('binary files are described rather than dumped, and there is nothing to edit', async () => {
  stubApis(ok('', { binary: true, size: 4096 }))
  renderNode({ path: 'D:\\Development\\Toucan\\build\\icon.png' })
  const binary = await screen.findByRole('status')
  expect(binary).toHaveAttribute('data-reason', 'binary')
  expect(binary.textContent).toMatch(/4\.0 KB/)
  expect(document.querySelector('.cm-editor')).toBeNull()
})

test('a truncated read says how much of the file is shown and stays read-only', async () => {
  stubApis(ok('head', { truncated: true, size: 2048 }))
  renderNode({ path: 'D:\\Development\\Toucan\\big.log' })
  const notice = await screen.findByRole('status')
  expect(notice).toHaveAttribute('data-reason', 'truncated')
  expect(notice.textContent).toMatch(/of 2\.0 KB/)
  const view = await editor()
  // Saving the first megabyte back as the whole file would destroy the rest: no edit is accepted.
  expect(view.state.readOnly).toBe(true)
  expect(view.contentDOM.getAttribute('contenteditable')).toBe('false')
})

test('typing makes a draft, Save writes it with the mtime it was based on, and the node rebases', async () => {
  const stub = stubApis(ok('# Plan\n'))
  renderNode({ view: 'raw' })
  const view = await editor()
  expect(view.state.readOnly).toBe(false)
  expect(screen.queryByRole('button', { name: /^Save/ })).toBeNull()

  type(view, '\nMore.\n')
  expect(await screen.findByLabelText('Unsaved changes')).toBeInTheDocument()
  expect(document.querySelector('.file-node')).toHaveAttribute('data-dirty', 'true')

  fireEvent.click(saveButton())
  await waitFor(() => expect(stub.write).toHaveBeenCalledTimes(1))
  expect(stub.write).toHaveBeenCalledWith({
    path: PATH,
    content: '# Plan\n\nMore.\n',
    baseMtime: '2026-09-05T09:00:00.000Z'
  })
  await waitFor(() => expect(screen.queryByLabelText('Unsaved changes')).toBeNull())
  expect(view.state.doc.toString()).toBe('# Plan\n\nMore.\n')

  // The watcher reports the node's own save; with the mtime the write returned, it is not news.
  stub.read.mockResolvedValue(ok('# Plan\n\nMore.\n', { mtime: 'saved' }))
  act(() => stub.emitChange(PATH))
  await waitFor(() => expect(stub.read).toHaveBeenCalledTimes(2))
  expect(screen.queryByRole('alert')).toBeNull()

  // The next edit is based on the saved file.
  type(view, 'Again.\n')
  fireEvent.click(await screen.findByRole('button', { name: 'Save' }))
  await waitFor(() => expect(stub.write).toHaveBeenCalledTimes(2))
  expect(stub.write.mock.calls[1][0]).toMatchObject({ baseMtime: 'saved' })
})

test('keystrokes during a save become a new draft on the saved file, and a second Ctrl+S waits', async () => {
  let finish: (result: FileWriteResult) => void = () => {}
  const stub = stubApis(ok('one\n'), () => new Promise<FileWriteResult>((resolve) => (finish = resolve)))
  renderNode({ path: TEXT_PATH })
  const view = await editor()
  type(view, 'two\n')
  fireEvent.keyDown(view.contentDOM, { key: 's', ctrlKey: true })
  fireEvent.keyDown(view.contentDOM, { key: 's', ctrlKey: true })
  await waitFor(() => expect(stub.write).toHaveBeenCalledTimes(1))
  expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled()

  type(view, 'three\n')
  await act(async () => finish({ ok: true, mtime: 'saved', size: 8 }))

  // The write carried 'one\ntwo\n'; 'three' typed meanwhile is still here, unsaved, based on the save.
  expect(view.state.doc.toString()).toBe('one\ntwo\nthree\n')
  expect(screen.getByLabelText('Unsaved changes')).toBeInTheDocument()
  fireEvent.click(saveButton())
  await waitFor(() => expect(stub.write).toHaveBeenCalledTimes(2))
  expect(stub.write.mock.calls[1][0]).toMatchObject({ content: 'one\ntwo\nthree\n', baseMtime: 'saved' })
})

test('Ctrl+S inside the editor saves, and Discard returns to the file on disk', async () => {
  const stub = stubApis(ok('one\n'))
  renderNode({ path: TEXT_PATH })
  const view = await editor()
  type(view, 'two\n')
  fireEvent.keyDown(view.contentDOM, { key: 's', ctrlKey: true })
  await waitFor(() => expect(stub.write).toHaveBeenCalledTimes(1))
  expect(stub.write.mock.calls[0][0]).toMatchObject({ content: 'one\ntwo\n' })

  type(view, 'three\n')
  fireEvent.click(await screen.findByRole('button', { name: 'Discard' }))
  await waitFor(() => expect(view.state.doc.toString()).toBe('one\ntwo\n'))
  expect(screen.queryByRole('button', { name: 'Discard' })).toBeNull()
  expect(stub.write).toHaveBeenCalledTimes(1)
})

test('an external change under a draft is a conflict: the draft stays, and the reader chooses', async () => {
  const stub = stubApis(ok('mine\n'))
  renderNode({ path: TEXT_PATH })
  const view = await editor()
  type(view, 'edited\n')

  stub.read.mockResolvedValue(ok('theirs\n', { mtime: '2026-09-05T09:05:00.000Z' }))
  act(() => stub.emitChange(TEXT_PATH))
  const alert = await screen.findByRole('alert')
  expect(alert).toHaveAttribute('data-reason', 'changed')
  expect(alert.textContent).toMatch(/changed on disk/)
  // Nothing was written and the draft was not replaced; the external change is shown beside it.
  expect(stub.write).not.toHaveBeenCalled()
  expect(view.state.doc.toString()).toBe('mine\nedited\n')
  expect(document.querySelector('.file-node-conflict-disk pre')?.textContent).toBe('theirs\n')
  expect(saveButton()).toBeDisabled()

  // Keeping the edits rebases them on what is now on disk, so the next save is accepted.
  fireEvent.click(screen.getByRole('button', { name: 'Keep my edits' }))
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
  expect(view.state.doc.toString()).toBe('mine\nedited\n')
  fireEvent.click(saveButton())
  await waitFor(() => expect(stub.write).toHaveBeenCalledTimes(1))
  expect(stub.write.mock.calls[0][0]).toMatchObject({
    content: 'mine\nedited\n',
    baseMtime: '2026-09-05T09:05:00.000Z'
  })
})

test('reloading from disk resolves a conflict in favour of the file', async () => {
  const stub = stubApis(ok('mine\n'))
  renderNode({ path: TEXT_PATH })
  const view = await editor()
  type(view, 'edited\n')
  stub.read.mockResolvedValue(ok('theirs\n', { mtime: '2026-09-05T09:05:00.000Z' }))
  act(() => stub.emitChange(TEXT_PATH))
  fireEvent.click(await screen.findByRole('button', { name: 'Reload from disk' }))
  await waitFor(() => expect(view.state.doc.toString()).toBe('theirs\n'))
  expect(screen.queryByRole('alert')).toBeNull()
  expect(screen.queryByLabelText('Unsaved changes')).toBeNull()
})

test('a save main refuses as a conflict is shown as one rather than retried', async () => {
  const stub = stubApis(ok('mine\n'), async () => ({ ok: false, reason: 'conflict', message: 'changed' }))
  renderNode({ path: TEXT_PATH })
  const view = await editor()
  type(view, 'edited\n')
  // By the time Save lands, disk has moved on and main says so; the node re-reads to show it.
  stub.read.mockResolvedValue(ok('theirs\n', { mtime: '2026-09-05T09:05:00.000Z' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Save' }))
  const alert = await screen.findByRole('alert')
  expect(alert).toHaveAttribute('data-reason', 'changed')
  expect(view.state.doc.toString()).toBe('mine\nedited\n')
  expect(stub.write).toHaveBeenCalledTimes(1)
})

test('a file deleted under a draft keeps the draft and says the file is gone', async () => {
  const stub = stubApis(ok('mine\n'))
  renderNode({ path: TEXT_PATH })
  const view = await editor()
  type(view, 'edited\n')
  stub.read.mockResolvedValue({ ok: false, reason: 'not-found', message: 'gone' })
  act(() => stub.emitChange(TEXT_PATH))
  const alert = await screen.findByRole('alert')
  expect(alert).toHaveAttribute('data-reason', 'gone')
  expect(view.state.doc.toString()).toBe('mine\nedited\n')
  expect(screen.queryByRole('button', { name: 'Keep my edits' })).toBeNull()
  expect(screen.getByRole('button', { name: 'Drop my edits' })).toBeInTheDocument()
})

test('a write refused outside the workspace is reported in the node, and the draft survives', async () => {
  const stub = stubApis(ok('mine\n'), async () => ({ ok: false, reason: 'outside-workspace', message: 'no' }))
  renderNode({ path: TEXT_PATH })
  const view = await editor()
  type(view, 'edited\n')
  fireEvent.click(await screen.findByRole('button', { name: 'Save' }))
  const alert = await screen.findByRole('alert')
  expect(alert).toHaveAttribute('data-reason', 'outside-workspace')
  expect(alert.textContent).toMatch(/does not write it/)
  expect(stub.write).toHaveBeenCalledTimes(1)
  expect(view.state.doc.toString()).toBe('mine\nedited\n')
})

test('with unsaved edits the rendered view previews the draft and still offers Save', async () => {
  stubApis(ok('# Plan\n'))
  const { rerender } = renderNode({ view: 'raw' })
  const view = await editor()
  type(view, '\n## Next\n')
  rerender({ view: 'rendered' })
  expect(await screen.findByRole('heading', { level: 2, name: 'Next' })).toBeInTheDocument()
  expect(saveButton()).toBeEnabled()
  expect(screen.getByLabelText('Unsaved changes')).toBeInTheDocument()
})

test('the rendered view lifts frontmatter into a metadata table instead of running it into the prose', async () => {
  stubApis(ok('---\nname: jira-ticket\ndescription: Create a ticket.\n---\n\n# Jira ticket\n\nTurn a request.\n'))
  renderNode()

  const heading = await screen.findByRole('heading', { level: 1, name: 'Jira ticket' })
  const rows = document.querySelectorAll('.markdown-frontmatter tr')
  expect([...rows].map((row) => [...row.children].map((cell) => cell.textContent))).toEqual([
    ['name', 'jira-ticket'],
    ['description', 'Create a ticket.']
  ])
  // The delimiters and the fields are gone from the prose; only the body is Markdown.
  expect(heading.closest('.file-node-prose')?.textContent).not.toContain('description:')
})

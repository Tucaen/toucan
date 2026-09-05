import { readFileSync } from 'node:fs'
import { ReactFlowProvider } from '@xyflow/react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import type { FileReadResult } from '../src/shared/file-view'
import type { FileCanvasNode } from '../src/renderer/src/canvas-workspace'
import FileNode from '../src/renderer/src/FileNode'

/*
 * The file node (issue #143): one project file on the canvas, Markdown rendered by default with a
 * raw toggle, everything else raw only, live-updating, and honest about a file that is not there.
 */

const PATH = 'D:\\Development\\Toucan\\docs\\plan.md'

interface Stub {
  read: ReturnType<typeof vi.fn>
  watch: ReturnType<typeof vi.fn>
  unwatch: ReturnType<typeof vi.fn>
  emitChange: (path: string) => void
  copyText: ReturnType<typeof vi.fn>
  showItemInFolder: ReturnType<typeof vi.fn>
}

function stubApis(result: FileReadResult): Stub {
  let listener: ((path: string) => void) | null = null
  const read = vi.fn(async () => result)
  const watch = vi.fn(async () => undefined)
  const unwatch = vi.fn(async () => undefined)
  const copyText = vi.fn()
  const showItemInFolder = vi.fn(async () => undefined)
  Object.defineProperty(window, 'fileViewApi', {
    configurable: true,
    writable: true,
    value: {
      read,
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
  return { read, watch, unwatch, emitChange: (path) => listener?.(path), copyText, showItemInFolder }
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

function renderNode(data: Partial<FileCanvasNode['data']> = {}): { onViewModeChange: ReturnType<typeof vi.fn> } {
  const onViewModeChange = vi.fn()
  render(
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
        data={{
          path: PATH,
          view: 'rendered',
          projectId: 'project',
          projectName: 'Toucan',
          projectPath: 'D:\\Development\\Toucan',
          projectColor: '#71a9ff',
          onViewModeChange,
          ...data
        }}
      />
    </ReactFlowProvider>
  )
  return { onViewModeChange }
}

test('renders Markdown by default and offers the raw view through the node, not local state', async () => {
  stubApis(ok('# Plan\n\nRead **this**.\n'))
  const { onViewModeChange } = renderNode()

  expect(await screen.findByRole('heading', { level: 1, name: 'Plan' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Rendered' })).toHaveAttribute('aria-pressed', 'true')

  fireEvent.click(screen.getByRole('button', { name: 'Raw' }))
  expect(onViewModeChange).toHaveBeenCalledWith('file-1', 'raw')
  // Clicking the already-active view is not a change.
  fireEvent.click(screen.getByRole('button', { name: 'Rendered' }))
  expect(onViewModeChange).toHaveBeenCalledTimes(1)
})

test('the raw view shows numbered source lines, and a non-Markdown file has no toggle', async () => {
  stubApis(ok('const a = 1\nconst b = 2\n'))
  renderNode({ path: 'D:\\Development\\Toucan\\src\\index.ts', view: 'rendered' })

  await waitFor(() => expect(document.querySelectorAll('.file-node-line')).toHaveLength(2))
  expect(screen.queryByRole('button', { name: 'Rendered' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Raw' })).toBeNull()
  const lines = document.querySelectorAll('.file-node-line')
  // Highlighting splits a line into tokens; the line still reads as its source text.
  expect(lines[1].querySelector('.file-node-line-text')?.textContent).toBe('const b = 2')
  expect(lines[1].querySelector('.hljs-keyword')).not.toBeNull()
  expect(lines[1].querySelector('.file-node-line-number')?.textContent).toBe('2')
  expect(document.querySelector('.file-node-body')?.getAttribute('data-view')).toBe('raw')
})

test('a Markdown file the reader switched to raw comes back raw', async () => {
  stubApis(ok('# Plan\n'))
  renderNode({ view: 'raw' })
  await screen.findByText('# Plan')
  expect(screen.queryByRole('heading')).toBeNull()
  expect(screen.getByRole('button', { name: 'Raw' })).toHaveAttribute('aria-pressed', 'true')
})

test('a file that is gone keeps its node and says so', async () => {
  stubApis({ ok: false, reason: 'not-found', message: 'gone' })
  renderNode()
  const notice = await screen.findByRole('status')
  expect(notice).toHaveAttribute('data-reason', 'not-found')
  expect(notice.textContent).toMatch(/not on disk/)
  // The header still names the file, so the reader knows what the empty node was showing.
  expect(screen.getByText('plan.md')).toBeInTheDocument()
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
  const { unmount } = render(
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
        data={{
          path: PATH,
          view: 'raw',
          projectId: 'project',
          projectName: 'Toucan',
          projectPath: 'D:\\Development\\Toucan',
          projectColor: '#71a9ff',
          onViewModeChange: vi.fn()
        }}
      />
    </ReactFlowProvider>
  )
  await screen.findByText('before')
  expect(stub.watch).toHaveBeenCalledWith(PATH)

  stub.read.mockResolvedValue(ok('after'))
  // A different file changing is not this node's business.
  act(() => stub.emitChange('D:\\Development\\Toucan\\docs\\other.md'))
  expect(stub.read).toHaveBeenCalledTimes(1)
  // The same file under another spelling of its path is.
  act(() => stub.emitChange('d:/development/toucan/docs/PLAN.md'))
  await waitFor(() => expect(screen.getByText('after')).toBeInTheDocument())

  unmount()
  expect(stub.unwatch).toHaveBeenCalledWith(PATH)
})

test('binary and truncated files are described rather than dumped', async () => {
  stubApis(ok('', { binary: true, size: 4096 }))
  renderNode({ path: 'D:\\Development\\Toucan\\build\\icon.png' })
  const binary = await screen.findByRole('status')
  expect(binary).toHaveAttribute('data-reason', 'binary')
  expect(binary.textContent).toMatch(/4\.0 KB/)
})

test('a truncated read says how much of the file is shown', async () => {
  stubApis(ok('head', { truncated: true, size: 2048 }))
  renderNode({ path: 'D:\\Development\\Toucan\\big.log' })
  const notice = await screen.findByRole('status')
  expect(notice).toHaveAttribute('data-reason', 'truncated')
  expect(notice.textContent).toMatch(/of 2\.0 KB/)
})

test('the body scrolls with the same thin canvas scrollbar as the chat transcript', () => {
  const styles = readFileSync('src/renderer/src/styles.css', 'utf8')
  // Every declaration block the selector closes, since a selector can appear in several rules.
  const rule = (selector: string): string =>
    [...styles.matchAll(new RegExp(`\\n${selector.replace(/\./g, '\\.')} \\{([^}]*)\\}`, 'g'))]
      .map((match) => match[1])
      .join('\n')
  const scrollbar = (block: string): string[] =>
    block
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('scrollbar-'))
      .sort()
  expect(scrollbar(rule('.file-node-body')).length).toBeGreaterThan(0)
  expect(scrollbar(rule('.file-node-body'))).toEqual(scrollbar(rule('.chat-scroll')))
})
